"""Конвейер: кадр -> препятствия.

Engine  — тяжёлые модели (YOLO, глубина), загружаются один раз на сервер.
Session — состояние одного клиента (трекинг, сглаживание, калибровка, пол, движение).
Используется и WebSocket-сервером, и tools/run_video.py.

Два источника препятствий:
  1. Детектор — люди, транспорт, животные (то, что может двигаться).
  2. Карта глубины — всё остальное, без классов (деревья, столбы, стены...).
"""
import dataclasses
import threading
import time

import numpy as np
import torch

from . import distance as dist
from .config import DEPTH_MODELS, GENERIC_CLASS, Scene, Settings
from .depth import DepthEstimator
from .detection import Detector, Tracker
from .free_space import ZONES, FreeSpaceAnalyzer
from .motion import MotionEstimator
from .schemas import Detection, DistanceEstimate, FrameDebug, Kind, Obstacle, TrackedObject
from .spatial import urgency, zone_and_pan


class Engine:
    def __init__(self, settings: Settings | None = None):
        self.settings = settings or Settings()
        self.device = self.settings.device if torch.cuda.is_available() else "cpu"
        print(f"[engine] device={self.device}")
        self.detector = Detector(self.settings, self.device)
        self._depth: dict[str, DepthEstimator] = {}
        self._depth_lock = threading.Lock()
        # Прогрев CUDA, чтобы первый кадр клиента не ждал ~2 секунды
        warm = np.zeros((480, 640, 3), np.uint8)
        self.detector.detect(warm)
        self.depth(self.settings.depth_model_id).estimate(warm)

    def depth(self, model_id: str) -> DepthEstimator:
        """Модели глубины (улица/помещение) загружаются лениво и кэшируются."""
        with self._depth_lock:
            if model_id not in self._depth:
                print(f"[engine] загрузка {model_id}")
                self._depth[model_id] = DepthEstimator(model_id, self.device, self.settings.depth_input_size)
            return self._depth[model_id]

    def new_session(self, scene: Scene | None = None, hfov_deg: float | None = None) -> "Session":
        return Session(self, scene=scene, hfov_deg=hfov_deg)


class Session:
    def __init__(self, engine: Engine, scene: Scene | None = None, hfov_deg: float | None = None):
        self.engine = engine
        self.s = dataclasses.replace(engine.settings)
        self.tracker = Tracker(engine.detector.names) if self.s.use_tracking else None
        self.smoother = dist.DistanceSmoother(self.s)
        self.calibrator = dist.DepthScaleCalibrator(self.s)
        self.free_space = FreeSpaceAnalyzer(self.s)
        self.motion = MotionEstimator(self.s)
        self.frame_idx = 0
        self.configure(scene=scene, hfov_deg=hfov_deg)

    def configure(self, scene: Scene | None = None, hfov_deg: float | None = None) -> None:
        """Смена сцены/камеры. Калибровку и пол сбрасываем — они зависят от модели и FOV."""
        changed = False
        if scene is not None and DEPTH_MODELS[scene] != self.s.depth_model_id:
            self.s.depth_model_id = DEPTH_MODELS[scene]
            changed = True
        if hfov_deg is not None and hfov_deg != self.s.camera_hfov_deg:
            self.s.camera_hfov_deg = hfov_deg
            changed = True
        if changed:
            self.calibrator.reset()
            self.free_space.reset()
        self.depth = self.engine.depth(self.s.depth_model_id)

    def process(self, frame_bgr: np.ndarray, timestamp: float | None = None) -> tuple[list[Obstacle], FrameDebug]:
        """timestamp — время кадра в секундах (для скорости). По умолчанию — текущее."""
        t_frame = time.monotonic() if timestamp is None else timestamp
        t0 = time.perf_counter()
        boxes = self.engine.detector.detect(frame_bgr)
        if self.tracker is not None:
            detections = self.tracker.update(boxes, frame_bgr)
        else:
            detections = self.engine.detector.to_detections(boxes)
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

        candidates: list[tuple[Detection, Kind, float | None, float | None]] = []
        for det, depth_m, geom_m in raw:
            kind: Kind = self.s.dynamic_classes.get(det.cls, "obstacle")  # type: ignore[assignment]
            candidates.append((det, kind, None if depth_m is None else depth_m * scale, geom_m))

        # Препятствия без классов по карте глубины (одно ближайшее на зону)
        free_dbg = None
        if self.s.generic_obstacles:
            generic, free_dbg = self.free_space.analyze(depth_map * scale, detections)
            for g in generic:
                det = Detection(track_id=-(ZONES.index(g.zone) + 1), cls=GENERIC_CLASS,
                                conf=min(1.0, round(g.area * 20, 2)), box=g.box)
                candidates.append((det, "obstacle", g.distance_m, None))
        t3 = time.perf_counter()

        objects: list[TrackedObject] = []
        for det, kind, depth_m, geom_m in candidates:
            fused = dist.fuse(depth_m, geom_m, self.s)
            if fused is None:
                continue
            fused = min(max(fused, self.s.min_distance_m), self.s.max_distance_m)
            smoothed = self.smoother.update(det.track_id, fused, self.frame_idx)
            motion = self.motion.update(det.track_id, t_frame, smoothed)
            zone, pan = zone_and_pan(det.box, fw)
            objects.append(TrackedObject(
                detection=det,
                kind=kind,
                distance=DistanceEstimate(depth_m, geom_m, fused, smoothed),
                zone=zone,
                pan=pan,
                urgency=urgency(smoothed, motion.ttc_s, self.s),
                approach_mps=motion.approach_mps,
                ttc_s=motion.ttc_s,
                moving=motion.moving,
            ))
        objects.sort(key=lambda o: o.distance.smoothed_m)
        t4 = time.perf_counter()

        obstacles = [
            Obstacle(
                id=o.detection.track_id,
                kind=o.kind,
                cls=o.detection.cls,
                zone=o.zone,
                pan=o.pan,
                distance=round(o.distance.smoothed_m, 2),
                urgency=o.urgency,
                approach=o.approach_mps,
                ttc=o.ttc_s,
                moving=o.moving,
                conf=round(o.detection.conf, 2),
                box=(
                    round(o.detection.box[0] / fw, 3),
                    round(o.detection.box[1] / fh, 3),
                    round(o.detection.box[2] / fw, 3),
                    round(o.detection.box[3] / fh, 3),
                ),
            )
            for o in objects
        ]
        debug = FrameDebug(
            objects=objects,
            depth_map=depth_map,
            depth_scale=scale,
            free_space=free_dbg,
            timings_ms={
                "detect": (t1 - t0) * 1000,
                "depth": (t2 - t1) * 1000,
                "free": (t3 - t2) * 1000,
                "post": (t4 - t3) * 1000,
                "total": (t4 - t0) * 1000,
            },
        )
        self.frame_idx += 1
        return obstacles, debug
