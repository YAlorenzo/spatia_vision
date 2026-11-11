"""YOLO11 + ByteTrack: объекты со стабильными ID между кадрами."""
import numpy as np
from ultralytics import YOLO

from .config import Settings
from .schemas import Detection


class Detector:
    def __init__(self, settings: Settings, device: str):
        self.s = settings
        self.device = device
        self.model = YOLO(str(settings.yolo_weights))
        names = self.model.names
        self.allowed_ids = [i for i, n in names.items() if n in settings.obstacle_classes]

    def reset(self) -> None:
        """Сбросить состояние трекера (новое видео / новый клиент)."""
        predictor = getattr(self.model, "predictor", None)
        if predictor is not None and getattr(predictor, "trackers", None):
            for t in predictor.trackers:
                t.reset()

    def detect(self, frame_bgr: np.ndarray) -> list[Detection]:
        kwargs = dict(
            conf=self.s.yolo_conf,
            imgsz=self.s.yolo_imgsz,
            classes=self.allowed_ids,
            device=self.device,
            half=self.device.startswith("cuda"),
            verbose=False,
        )
        if self.s.use_tracking:
            result = self.model.track(frame_bgr, persist=True, tracker="bytetrack.yaml", **kwargs)[0]
        else:
            result = self.model.predict(frame_bgr, **kwargs)[0]

        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return []
        xyxy = boxes.xyxy.cpu().numpy().astype(int)
        cls = boxes.cls.cpu().numpy().astype(int)
        conf = boxes.conf.cpu().numpy()
        ids = boxes.id.cpu().numpy().astype(int) if boxes.id is not None else [None] * len(boxes)
        return [
            Detection(
                track_id=None if tid is None else int(tid),
                cls=self.model.names[int(c)],
                conf=float(p),
                box=tuple(int(v) for v in b),
            )
            for b, c, p, tid in zip(xyxy, cls, conf, ids)
        ]
