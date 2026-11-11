"""Единый конвейер: кадр -> препятствия. Используется и сервером, и tools/run_video.py."""
import time

import numpy as np
import torch

from . import distance as dist
from .config import Settings
from .depth import DepthEstimator
from .detection import Detector
from .schemas import DistanceEstimate, FrameDebug, FrameResult, Obstacle, TrackedObject
from .spatial import urgency, zone_and_pan


class Pipeline:
    def __init__(self, settings: Settings | None = None):
        self.s = settings or Settings()
        self.device = self.s.device if torch.cuda.is_available() else "cpu"
        print(f"[pipeline] device={self.device}, depth={self.s.depth_model_id}")
        self.detector = Detector(self.s, self.device)
        self.depth = DepthEstimator(self.s.depth_model_id, self.device, self.s.depth_input_size)
        self.smoother = dist.DistanceSmoother(self.s)
        self.calibrator = dist.DepthScaleCalibrator(self.s)
        self.frame_idx = 0

    def reset(self) -> None:
        """Вызывать при смене видео/клиента: сбрасывает трекинг и сглаживание."""
        self.detector.reset()
        self.smoother.reset()
        self.calibrator.reset()
        self.frame_idx = 0

    def process(self, frame_bgr: np.ndarray) -> tuple[FrameResult, FrameDebug]:
        t0 = time.perf_counter()
        detections = self.detector.detect(frame_bgr)
        t1 = time.perf_counter()
        depth_map = self.depth.estimate(frame_bgr)
        t2 = time.perf_counter()

        fh, fw = frame_bgr.shape[:2]
        raw = []
        for det in detections:
            depth_m = dist.sample_depth(depth_map, det.box, self.s)
            geom_m = dist.geometry_distance(det, (fh, fw), self.s) if self.s.use_geometry else None
            raw.append((det, depth_m, geom_m))

        # Калибровка масштаба глубины по объектам известного размера в этом кадре
        self.calibrator.update([(d, g) for _, d, g in raw if d is not None and g is not None])
        scale = self.calibrator.scale

        objects: list[TrackedObject] = []
        for det, depth_m, geom_m in raw:
            if depth_m is not None:
                depth_m *= scale
            fused = dist.fuse(depth_m, geom_m, self.s)
            if fused is None:
                continue
            fused = min(max(fused, self.s.min_distance_m), self.s.max_distance_m)
            smoothed = self.smoother.update(det.track_id, fused, self.frame_idx)
            zone, pan = zone_and_pan(det.box, fw)
            objects.append(TrackedObject(
                detection=det,
                distance=DistanceEstimate(depth_m, geom_m, fused, smoothed),
                zone=zone,
                pan=pan,
                urgency=urgency(smoothed, self.s),
            ))
        objects.sort(key=lambda o: o.distance.smoothed_m)
        t3 = time.perf_counter()

        result = FrameResult(
            frame_id=self.frame_idx,
            obstacles=[
                Obstacle(
                    id=o.detection.track_id,
                    cls=o.detection.cls,
                    zone=o.zone,
                    pan=o.pan,
                    distance=round(o.distance.smoothed_m, 2),
                    urgency=o.urgency,
                    conf=round(o.detection.conf, 2),
                )
                for o in objects
            ],
        )
        debug = FrameDebug(
            objects=objects,
            depth_map=depth_map,
            depth_scale=scale,
            timings_ms={
                "detect": (t1 - t0) * 1000,
                "depth": (t2 - t1) * 1000,
                "post": (t3 - t2) * 1000,
                "total": (t3 - t0) * 1000,
            },
        )
        self.frame_idx += 1
        return result, debug
