"""YOLO11 (общая модель) + ByteTrack (свой трекер у каждой сессии)."""
import numpy as np
from ultralytics import YOLO
from ultralytics.trackers.byte_tracker import BYTETracker
from ultralytics.utils import YAML, IterableSimpleNamespace
from ultralytics.utils.checks import check_yaml

from .config import Settings
from .schemas import Detection


class Detector:
    """Только детекция, без состояния — одна на весь сервер."""

    def __init__(self, settings: Settings, device: str):
        self.s = settings
        self.device = device
        self.model = YOLO(str(settings.yolo_weights))
        self.names: dict[int, str] = self.model.names
        self.dynamic_ids = [i for i, n in self.names.items() if n in settings.dynamic_classes]
        self.static_ids = [i for i, n in self.names.items() if n in settings.static_classes]
        self.allowed_ids = self.dynamic_ids + self.static_ids

    def detect(self, frame_bgr: np.ndarray):
        """Возвращает ultralytics Boxes (numpy) — их понимает и трекер."""
        result = self.model.predict(
            frame_bgr,
            conf=self.s.yolo_conf,
            imgsz=self.s.yolo_imgsz,
            classes=self.allowed_ids,
            device=self.device,
            half=self.device.startswith("cuda"),
            verbose=False,
        )[0]
        return result.boxes.cpu().numpy()

    def split(self, boxes):
        """Boxes -> (то, что может двигаться: в трекер; неподвижные предметы с именем: list[Detection])."""
        if len(boxes) == 0:
            return boxes, []
        dyn = np.isin(boxes.cls, self.dynamic_ids)
        static = [
            Detection(track_id=None, cls=self.names[int(c)], conf=float(p), box=tuple(int(v) for v in b))
            for b, c, p in zip(boxes.xyxy[~dyn], boxes.cls[~dyn], boxes.conf[~dyn])
            if p >= self.s.static_conf
        ]
        return boxes[dyn], static

    def to_detections(self, boxes) -> list[Detection]:
        return [
            Detection(
                track_id=None,
                cls=self.names[int(c)],
                conf=float(p),
                box=tuple(int(v) for v in b),
            )
            for b, c, p in zip(boxes.xyxy, boxes.cls, boxes.conf)
            # без трекера слабые рамки не к чему привязать — только уверенные
            if p >= self.s.confirm_conf.get(self.names[int(c)], self.s.confirm_conf_default)
        ]


class Tracker:
    """ByteTrack: стабильные ID объектов между кадрами. Состояние — на сессию."""

    def __init__(self, names: dict[int, str], settings: Settings):
        cfg = IterableSimpleNamespace(**YAML.load(check_yaml("bytetrack.yaml")))
        self.tracker = BYTETracker(cfg)
        self.names = names
        self.s = settings
        self.confirmed: set[int] = set()  # треки, хоть раз увиденные уверенно

    def reset(self) -> None:
        self.tracker.reset()
        self.confirmed.clear()

    def update(self, boxes, frame_bgr: np.ndarray) -> list[Detection]:
        if len(boxes) == 0:
            return []
        tracks = self.tracker.update(boxes, frame_bgr)  # [x1,y1,x2,y2,id,score,cls,idx]
        out = []
        for t in tracks:
            tid, cls, conf = int(t[4]), self.names[int(t[6])], float(t[5])
            if tid not in self.confirmed:
                if conf < self.s.confirm_conf.get(cls, self.s.confirm_conf_default):
                    continue  # слабая рамка нового объекта — скорее ложная, ждём уверенную
                self.confirmed.add(tid)
            out.append(Detection(track_id=tid, cls=cls, conf=conf, box=tuple(int(v) for v in t[:4])))
        if len(self.confirmed) > 5000:  # id растут бесконечно — чистим старые
            alive = {int(t[4]) for t in tracks}
            self.confirmed &= alive
        return out
