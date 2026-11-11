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
        self.allowed_ids = [i for i, n in self.names.items() if n in settings.obstacle_classes]

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

    def to_detections(self, boxes) -> list[Detection]:
        return [
            Detection(
                track_id=None,
                cls=self.names[int(c)],
                conf=float(p),
                box=tuple(int(v) for v in b),
            )
            for b, c, p in zip(boxes.xyxy, boxes.cls, boxes.conf)
        ]


class Tracker:
    """ByteTrack: стабильные ID объектов между кадрами. Состояние — на сессию."""

    def __init__(self, names: dict[int, str]):
        cfg = IterableSimpleNamespace(**YAML.load(check_yaml("bytetrack.yaml")))
        self.tracker = BYTETracker(cfg)
        self.names = names

    def reset(self) -> None:
        self.tracker.reset()

    def update(self, boxes, frame_bgr: np.ndarray) -> list[Detection]:
        if len(boxes) == 0:
            return []
        tracks = self.tracker.update(boxes, frame_bgr)  # [x1,y1,x2,y2,id,score,cls,idx]
        return [
            Detection(
                track_id=int(t[4]),
                cls=self.names[int(t[6])],
                conf=float(t[5]),
                box=tuple(int(v) for v in t[:4]),
            )
            for t in tracks
        ]
