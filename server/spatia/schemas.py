"""Формат данных конвейера и ответа клиенту."""
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

Zone = Literal["left", "center", "right"]
Urgency = Literal["high", "medium", "low"]


@dataclass
class Detection:
    track_id: int | None
    cls: str
    conf: float
    box: tuple[int, int, int, int]  # x1, y1, x2, y2


@dataclass
class DistanceEstimate:
    depth_m: float | None  # по модели глубины (с поправкой масштаба)
    geometry_m: float | None  # по известной высоте объекта
    fused_m: float  # итог за этот кадр
    smoothed_m: float  # после сглаживания во времени (это уходит клиенту)


@dataclass
class TrackedObject:
    detection: Detection
    distance: DistanceEstimate
    zone: Zone
    pan: float
    urgency: Urgency


@dataclass
class FrameDebug:
    """Внутренние данные для визуализации/отладки — клиенту не отправляются."""
    objects: list[TrackedObject] = field(default_factory=list)
    depth_map: "object | None" = None  # np.ndarray, метры (до автокалибровки)
    depth_scale: float = 1.0  # текущая поправка масштаба глубины
    timings_ms: dict[str, float] = field(default_factory=dict)


class Obstacle(BaseModel):
    id: int | None
    cls: str
    zone: Zone
    pan: float  # -1 (слева) .. 1 (справа) — для панорамы звука
    distance: float  # метры
    urgency: Urgency
    conf: float


class FrameResult(BaseModel):
    frame_id: int
    obstacles: list[Obstacle]  # отсортированы: ближайшие первыми
