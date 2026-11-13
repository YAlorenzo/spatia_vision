"""Конвейер: кадр -> препятствия.

Engine  — тяжёлые модели (YOLO, глубина), загружаются один раз на сервер.
Session — состояние одного клиента (трекинг, сглаживание, калибровка, пол, движение).
Используется и WebSocket-сервером, и tools/run_video.py.

Два источника препятствий:
  1. Детектор — люди, транспорт, животные (то, что может двигаться).
  2. Карта глубины — всё остальное, без классов (деревья, столбы, стены...).
"""
import dataclasses
from collections import Counter, deque
import math
import threading
import time

import cv2
import numpy as np
import torch

from . import distance as dist
from .config import DEPTH_MODELS, GENERIC_CLASS, Scene, Settings
from .context import SceneContext
from .depth import DepthEstimator
from .detection import Detector, Tracker
from .free_space import ZONES, FreeSpaceAnalyzer, GenericObstacle
from .guidance import BypassAdvisor, lanes
from .motion import EgoMotion, MotionEstimator
from .schemas import Detection, DistanceEstimate, FrameDebug, Kind, Obstacle, TrackedObject, Zone
from .spatial import zone_and_pan
from .threat import ThreatAssessor


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
        self.tracker = Tracker(engine.detector.names, self.s) if self.s.use_tracking else None
        self.smoother = dist.DistanceSmoother(self.s)
        self.calibrator = dist.DepthScaleCalibrator(self.s)
        self.free_space = FreeSpaceAnalyzer(self.s)
        self.motion = MotionEstimator(self.s)
        self.ego = EgoMotion(self.s)
        self.threats = ThreatAssessor(self.s)
        self.context = SceneContext(self.s)
        self.bypass = BypassAdvisor(self.s)
        self._held: tuple[GenericObstacle, float] | None = None  # последнее подтверждённое препятствие на пути
        self._floor_raw: float | None = None  # высота камеры над полом в единицах модели глубины (прошлый кадр)
        self._names: dict[str, deque[str]] = {}  # последние названия препятствия по зонам
        self.frame_idx = 0
        self.configure(scene=scene, hfov_deg=hfov_deg)

    def configure(self, scene: Scene | None = None, hfov_deg: float | None = None) -> None:
        """Смена сцены/камеры. Калибровку и пол сбрасываем — они зависят от модели и FOV."""
        changed = False
        if scene is not None and DEPTH_MODELS[scene] != self.s.depth_model_id:
            self.s.depth_model_id = DEPTH_MODELS[scene]
            changed = True
        if hfov_deg is not None and hfov_deg != self.s.camera_fov_deg:
            self.s.camera_fov_deg = hfov_deg
            changed = True
        if changed:
            self.calibrator.reset()
            self.free_space.reset()
            self.ego.reset()
        self.depth = self.engine.depth(self.s.depth_model_id)

    def _name(self, g: GenericObstacle, statics: list[Detection]) -> str:
        """Название препятствия по глубине: предмет, который знает детектор (скамейка, стул...),
        иначе по форме (стена / столб / низкое), иначе просто "obstacle". Берётся самое частое
        за последние кадры — чтобы название не прыгало."""
        name = g.shape if g.shape != "obstacle" else GENERIC_CLASS
        gx, gy = (g.box[0] + g.box[2]) / 2, (g.box[1] + g.box[3]) / 2
        for d in statics:
            x1, y1, x2, y2 = d.box
            ix = max(0, min(x2, g.box[2]) - max(x1, g.box[0])) * max(0, min(y2, g.box[3]) - max(y1, g.box[1]))
            if x1 <= gx <= x2 and y1 <= gy <= y2 or ix > 0.5 * (x2 - x1) * (y2 - y1):
                name = d.cls
                break
        hist = self._names.setdefault(g.zone, deque(maxlen=7))
        hist.append(name)
        return Counter(hist).most_common(1)[0][0]

    def process(self, frame_bgr: np.ndarray, timestamp: float | None = None,
                up: np.ndarray | None = None) -> tuple[list[Obstacle], FrameDebug]:
        """timestamp — время кадра в секундах (для скорости). По умолчанию — текущее.
        up — направление "вверх" в координатах камеры (X вправо, Y вниз, Z вперёд) с датчика
        ориентации телефона; без него наклон оценивается по полу."""
        t_frame = time.monotonic() if timestamp is None else timestamp
        t0 = time.perf_counter()
        boxes, statics = self.engine.detector.split(self.engine.detector.detect(frame_bgr))
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
            if det.cls == "person" and det.box[1] > fh * self.s.hand_min_top and det.box[3] > fh * 0.97:
                # "Человек" только в нижней части кадра и упирается в край — это рука/нога
                # снимающего: настоящий человек рядом занимал бы кадр по высоте.
                # В free_space рамка остаётся — чтобы рука не стала "препятствием" по глубине.
                continue
            depth_m = dist.sample_depth(depth_map, det.box, self.s)
            geom_m = dist.geometry_distance(det, (fh, fw), self.s) if self.s.use_geometry else None
            raw.append((det, depth_m, geom_m))

        # Калибровка масштаба глубины по объектам известного размера в этом кадре
        pairs = [(d, g) for _, d, g in raw if d is not None and g is not None]
        if self._floor_raw is not None and self.s.camera_height_m > 0:
            # Пол — тоже "линейка": телефон в руке на известной высоте. Работает без людей в кадре —
            # иначе при неверном масштабе пол "уезжал" на 3 м вниз и препятствия не находились вовсе
            pairs.append((self._floor_raw, self.s.camera_height_m))
        self.calibrator.update(pairs)
        scale = self.calibrator.scale

        # (детекция, тип, дистанция по глубине, по геометрии, смещение вбок или None, зона или None)
        candidates: list[tuple[Detection, Kind, float | None, float | None, float | None, Zone | None]] = []
        for det, depth_m, geom_m in raw:
            kind: Kind = self.s.dynamic_classes.get(det.cls, "obstacle")  # type: ignore[assignment]
            candidates.append((det, kind, None if depth_m is None else depth_m * scale, geom_m, None, None))

        # Препятствия без классов по карте глубины: коридор движения + полосы по бокам
        free_dbg = None
        if self.s.generic_obstacles:
            generic, free_dbg = self.free_space.analyze(depth_map * scale, detections, up)
            self._floor_raw = None if free_dbg.fit_height is None else free_dbg.fit_height / scale
            real_center = any(g.zone == "center" for g in generic)
            if not real_center and self._held is not None and t_frame - self._held[1] < self.s.obstacle_hold_s:
                # Подтверждённое препятствие на пути мигнуло — держим, чтобы сигнал не прерывался
                generic.append(self._held[0])
            for g in generic:
                det = Detection(track_id=-(ZONES.index(g.zone) + 1), cls=self._name(g, statics),
                                conf=min(1.0, round(g.area * 20, 2)), box=g.box)
                candidates.append((det, "obstacle", g.distance_m, None, g.x_m, g.zone))
        t3 = time.perf_counter()

        # Земные оси (с учётом наклона и завала телефона) — из плоскости пола / датчика
        plane = free_dbg.plane if free_dbg is not None else self.free_space.plane
        focal = dist.focal_px(fw, fh, self.s.camera_fov_deg)

        objects: list[TrackedObject] = []
        for det, kind, depth_m, geom_m, gx, gzone in candidates:
            fused = dist.fuse(depth_m, geom_m, self.s)
            if fused is None:
                continue
            fused = min(max(fused, self.s.min_distance_m), self.s.max_distance_m)
            smoothed = self.smoother.update(det.track_id, fused, self.frame_idx)
            if gx is None:
                # Объект детектора: центр рамки -> 3D-точка камеры -> положение на земле.
                # Так "вперёд/вбок" верны и при наклонённом или заваленном вбок телефоне.
                cx = (det.box[0] + det.box[2]) / 2
                cy = (det.box[1] + det.box[3]) / 2
                p = np.array([(cx - fw / 2) / focal, (cy - fh / 2) / focal, 1.0]) * smoothed
                x_m, z_m = (float(v) for v in plane.to_ground(p))
            else:  # препятствие по глубине: уже в метрах по земле
                x_m, z_m = gx, smoothed
            bearing = math.degrees(math.atan2(x_m, max(z_m, 0.1)))
            # Рамка упирается в левый/правый край кадра — объект виден частично (проходишь мимо
            # припаркованной машины): по ней скорость не оценить, иначе стоящая машина "едет"
            truncated = gx is None and (det.box[0] <= 0.01 * fw or det.box[2] >= 0.99 * fw)
            # Скорость — по НЕсглаженной дистанции: скачок (человека заслонили, трекер перепутал
            # соседей в толпе) остаётся чистым скачком и сбрасывает историю, а не размазывается
            # сглаживанием на несколько кадров в ложное "сближение 9 м/с"
            k_raw = fused / smoothed
            motion = self.motion.update(det.track_id, t_frame, fused, x_m * k_raw, z_m * k_raw, truncated)
            zone, pan = zone_and_pan(det.box, fw)
            objects.append(TrackedObject(
                detection=det,
                kind=kind,
                distance=DistanceEstimate(depth_m, geom_m, fused, smoothed),
                zone=gzone or zone,
                pan=pan,
                urgency="low",
                bearing_deg=round(bearing, 1),
                lateral_m=abs(x_m),
                forward_m=z_m,
                approach_mps=motion.approach_mps,
                vx_mps=motion.vx_mps,
                vz_mps=motion.vz_mps,
                motion_valid=motion.valid,
            ))

        # Собственная скорость пользователя: одометрия по полу, запасной вариант — неподвижные препятствия
        gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
        ego = self.ego.update(
            gray,
            t_frame,
            plane,
            focal,
            [d.box for d in detections],
            [o.approach_mps for o in objects if o.kind in ("obstacle", "vehicle") and o.motion_valid],
        )
        # Главная опасность: коридор движения + то, что едет на пользователя
        self.threats.assess(objects, ego, focal, t_frame)
        # Толпа / парковка / слишком темно
        groups, hints = self.context.update(objects, gray, t_frame)
        # Запоминаем подтверждённое препятствие на пути (для удержания при мигании)
        if free_dbg is not None and real_center:
            c = next((o for o in objects if o.kind == "obstacle" and o.zone == "center"), None)
            g = next(g for g in generic if g.zone == "center")
            self._held = (g, t_frame) if c is not None and c.threat else None
        # С какой стороны обойти главную опасность
        primary = next((o for o in objects if o.primary), None)
        offsets: list[float] = []
        lane_state: list[str] = []
        if primary is not None and free_dbg is not None:
            offsets, lane_state = lanes(free_dbg.points, free_dbg.ground_points, objects, primary, focal, self.s)
        bypass = self.bypass.update(primary, offsets, lane_state)
        objects.sort(key=lambda o: (not o.primary, not o.threat, o.distance.smoothed_m))
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
                bearing=o.bearing_deg,
                in_path=o.in_path,
                approach=o.approach_mps,
                own_speed=o.own_speed_mps,
                ttc=o.ttc_s,
                moving=o.moving,
                threat=o.threat,
                primary=o.primary,
                alert=o.alert,
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
        # Всё остальное, что видно: области препятствий по глубине, не попавшие в три зоны, и предметы,
        # которые знает детектор. Только рамка (alert=info), без звука и без участия в выборе главной
        # опасности — но запоминаются: повернёшься к ним, и угроза включится без повторной проверки.
        shown = [o.detection.box for o in objects if o.kind == "obstacle"]
        extras: list[tuple[tuple[int, int, int, int], str, float, float, float]] = []  # рамка, имя, дистанция, x, conf

        def inside(px: float, py: float, box: tuple[int, int, int, int]) -> bool:
            return box[0] <= px <= box[2] and box[1] <= py <= box[3]

        if free_dbg is not None:
            for box, d_m, x_m in free_dbg.components:
                if any(inside((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, box) for b in shown):
                    continue  # эта область уже показана как препятствие одной из зон
                extras.append((box, GENERIC_CLASS, d_m, x_m, 0.5))
        named = {(o.detection.cls, o.detection.box) for o in objects if o.kind == "obstacle"}
        for det in statics:
            cx, cy = (det.box[0] + det.box[2]) / 2, (det.box[1] + det.box[3]) / 2
            if any(cls == det.cls and inside(cx, cy, box) for cls, box in named):
                continue  # этим предметом уже подписано препятствие зоны
            d_raw = dist.sample_depth(depth_map, det.box, self.s)
            if d_raw is None:
                continue
            d_m = min(max(d_raw * scale, self.s.min_distance_m), self.s.max_distance_m)
            pt = np.array([(cx - fw / 2) / focal, (cy - fh / 2) / focal, 1.0]) * d_m
            extras.append((det.box, det.cls, d_m, float(plane.to_ground(pt)[0]), det.conf))
        extras.sort(key=lambda e: e[2])
        for i, (box, cls, d_m, x_m, conf) in enumerate(extras[: self.s.max_extra_boxes]):
            zone, pan = zone_and_pan(box, fw)
            obstacles.append(Obstacle(
                id=-100 - i, kind="obstacle", cls=cls, zone="left" if x_m < 0 else "right", pan=pan,
                distance=round(d_m, 2), urgency="low",
                bearing=round(math.degrees(math.atan2(x_m, max(d_m, 0.1))), 1),
                in_path=False, approach=0.0, own_speed=0.0, ttc=None, moving=False, threat=False,
                primary=False, alert="info", conf=round(conf, 2),
                box=(round(box[0] / fw, 3), round(box[1] / fh, 3), round(box[2] / fw, 3), round(box[3] / fh, 3)),
            ))
        # Много предметов рядом — одной группой
        cl = self.context.cluster(
            [(e[3], e[2]) for e in extras] + [
                (math.copysign(o.lateral_m, o.bearing_deg), o.distance.smoothed_m) for o in objects if o.kind == "obstacle"],
            t_frame)
        if cl is not None:
            groups.append(cl)
        self.threats.note_aside(t_frame, [e[2] for e in extras] + [
            o.distance.smoothed_m for o in objects if o.kind == "obstacle" and o.zone != "center"])

        debug = FrameDebug(
            objects=objects,
            depth_map=depth_map,
            depth_scale=scale,
            free_space=free_dbg,
            ego_speed=ego,
            groups=groups,
            hints=hints,
            bypass=bypass,
            lanes=(offsets, lane_state),
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
