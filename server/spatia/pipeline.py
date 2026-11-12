"""Конвейер: кадр -> препятствия.

Engine  — тяжёлые модели (YOLO, глубина), загружаются один раз на сервер.
Session — состояние одного клиента (трекинг, сглаживание, калибровка, настройки камеры).
Используется и WebSocket-сервером, и tools/run_video.py.
"""
import dataclasses
import threading
import time

import numpy as np
import torch

from . import distance as dist
from .config import DEPTH_MODELS, Scene, Settings
from .depth import DepthEstimator
from .detection import Detector, Tracker
from .schemas import Detection, DistanceEstimate, FrameDebug, ManualCalibration, Obstacle, TrackedObject
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

    def new_session(
        self,
        scene: Scene | None = None,
        hfov_deg: float | None = None,
        depth_scale: float | None = None,
    ) -> "Session":
        session = Session(self, scene=scene, hfov_deg=hfov_deg)
        if depth_scale is not None:
            session.apply_manual_scale(depth_scale)
        return session


class Session:
    def __init__(self, engine: Engine, scene: Scene | None = None, hfov_deg: float | None = None):
        self.engine = engine
        self.s = dataclasses.replace(engine.settings)
        self.tracker = Tracker(engine.detector.names) if self.s.use_tracking else None
        self.smoother = dist.DistanceSmoother(self.s)
        self.calibrator = dist.DepthScaleCalibrator(self.s)
        self.manual_scale: float | None = None
        self.pending_distance_m: float | None = None
        self.notice: ManualCalibration | None = None
        self.scale_epoch = 0
        self.frame_idx = 0
        self.configure(scene=scene, hfov_deg=hfov_deg)

    def configure(
        self,
        scene: Scene | None = None,
        hfov_deg: float | None = None,
        depth_scale: float | None = None,
        apply_scale: bool = False,
    ) -> None:
        """Смена сцены/камеры. Автокалибровку сбрасываем — она зависит от модели и FOV.

        apply_scale=True значит, что depth_scale передан явно: число фиксирует
        ручной масштаб, None возвращает автокалибровку.
        """
        scene_changed = False
        if scene is not None and DEPTH_MODELS[scene] != self.s.depth_model_id:
            self.s.depth_model_id = DEPTH_MODELS[scene]
            scene_changed = True
            self.manual_scale = None
            self.s.auto_scale = True
            self.pending_distance_m = None
        if hfov_deg is not None and hfov_deg != self.s.camera_hfov_deg:
            self.s.camera_hfov_deg = hfov_deg
            scene_changed = True
        if scene_changed:
            self.calibrator.reset()
        if apply_scale:
            if depth_scale is None:
                self.clear_manual_scale(reset_hfov=False)
            else:
                self.apply_manual_scale(depth_scale)
        self.depth = self.engine.depth(self.s.depth_model_id)

    def apply_manual_scale(self, depth_scale: float) -> None:
        lo, hi = self.s.auto_scale_limits
        if not lo <= depth_scale <= hi:
            return
        self.scale_epoch += 1
        self.manual_scale = depth_scale
        self.s.auto_scale = False
        self.smoother.reset()

    def arm_calibration(self, distance_m: float) -> None:
        """Следующий обработанный кадр зафиксирует масштаб по центру кадра."""
        self.pending_distance_m = distance_m

    def clear_manual_scale(self, reset_hfov: bool = True) -> None:
        self.scale_epoch += 1
        self.manual_scale = None
        self.pending_distance_m = None
        self.s.auto_scale = True
        if reset_hfov:
            self.s.camera_hfov_deg = self.engine.settings.camera_hfov_deg
        self.calibrator.reset()
        self.smoother.reset()

    def take_notice(self) -> ManualCalibration | None:
        notice, self.notice = self.notice, None
        return notice

    def _lock_scale(
        self,
        depth_map: np.ndarray,
        detections: list[Detection],
        frame_hw: tuple[int, int],
        known: float,
    ) -> ManualCalibration:
        """Фиксирует масштаб: known / глубина в центре. Угол обзора — если в центре объект известной высоты."""
        center = dist.sample_center_depth(depth_map, self.s)
        if center is None or center < 0.05:
            return ManualCalibration(
                ok=False,
                distance_m=known,
                epoch=self.scale_epoch,
                message="В центре кадра нет дистанции. Наведите камеру на стену или человека и повторите.",
            )
        ratio = known / center
        lo, hi = self.s.auto_scale_limits
        if not lo <= ratio <= hi:
            return ManualCalibration(
                ok=False,
                distance_m=known,
                center_m=round(center, 2),
                epoch=self.scale_epoch,
                message=(
                    f"Модель видит {center:.1f} м, вы указали {known:.1f} м. "
                    "Расхождение слишком большое — проверьте расстояние и режим Улица/Помещение."
                ),
            )
        ratio = round(ratio, 3)
        self.scale_epoch += 1
        self.manual_scale = ratio
        self.s.auto_scale = False
        self.smoother.reset()
        hfov = dist.hfov_from_reference(detections, frame_hw, known, self.s)
        if hfov is not None:
            self.s.camera_hfov_deg = hfov
            self.calibrator.reset()
            message = f"Сохранено: масштаб ×{ratio:.2f}, угол обзора {hfov:.0f}°."
        else:
            message = (
                f"Сохранено: масштаб ×{ratio:.2f}. "
                "Угол обзора не изменён — в центре нет объекта известной высоты."
            )
        return ManualCalibration(
            ok=True,
            distance_m=known,
            depth_scale=ratio,
            hfov=hfov,
            center_m=round(center, 2),
            message=message,
            epoch=self.scale_epoch,
        )

    def process(self, frame_bgr: np.ndarray) -> tuple[list[Obstacle], FrameDebug]:
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

        if self.pending_distance_m is not None:
            known = self.pending_distance_m
            self.pending_distance_m = None
            self.notice = self._lock_scale(depth_map, [det for det, _, _ in raw], (fh, fw), known)
            if self.notice.ok and self.notice.hfov is not None:
                raw = [
                    (
                        det,
                        depth_m,
                        dist.geometry_distance(det, (fh, fw), self.s) if self.s.use_geometry else None,
                    )
                    for det, depth_m, _ in raw
                ]

        # Ручной масштаб, если он зафиксирован. Иначе автокалибровка по людям и машинам.
        if self.manual_scale is None:
            self.calibrator.update([(d, g) for _, d, g in raw if d is not None and g is not None])
            scale = self.calibrator.scale
        else:
            scale = self.manual_scale

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

        obstacles = [
            Obstacle(
                id=o.detection.track_id,
                cls=o.detection.cls,
                zone=o.zone,
                pan=o.pan,
                distance=round(o.distance.smoothed_m, 2),
                urgency=o.urgency,
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
            timings_ms={
                "detect": (t1 - t0) * 1000,
                "depth": (t2 - t1) * 1000,
                "post": (t3 - t2) * 1000,
                "total": (t3 - t0) * 1000,
            },
        )
        self.frame_idx += 1
        return obstacles, debug
