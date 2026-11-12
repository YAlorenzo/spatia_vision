"""Внутренние структуры конвейера и препятствие в ответе клиенту."""
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

Zone = Literal["left", "center", "right"]
Urgency = Literal["high", "medium", "low"]
Kind = Literal["person", "vehicle", "animal", "obstacle"]


@dataclass
class Detection:
    track_id: int | None
    cls: str
    conf: float
    box: tuple[int, int, int, int]  # x1, y1, x2, y2 (пиксели)


@dataclass
class DistanceEstimate:
    depth_m: float | None  # по модели глубины (с поправкой масштаба)
    geometry_m: float | None  # по известной высоте объекта
    fused_m: float  # итог за этот кадр
    smoothed_m: float  # после сглаживания во времени (это уходит клиенту)


@dataclass
class TrackedObject:
    detection: Detection
    kind: Kind
    distance: DistanceEstimate
    zone: Zone
    pan: float
    urgency: Urgency
    approach_mps: float = 0.0
    ttc_s: float | None = None
    moving: bool = False


@dataclass
class FrameDebug:
    """Внутренние данные для визуализации/отладки — клиенту не отправляются."""
    objects: list[TrackedObject] = field(default_factory=list)
    depth_map: "object | None" = None  # np.ndarray, метры (до автокалибровки)
    depth_scale: float = 1.0  # текущая поправка масштаба глубины
    free_space: "object | None" = None  # free_space.FreeSpaceDebug
    timings_ms: dict[str, float] = field(default_factory=dict)


class Obstacle(BaseModel):
    id: int | None  # для препятствий по глубине: -1/-2/-3 (зона слева/прямо/справа)
    kind: Kind  # person / vehicle / animal — по детектору; obstacle — по глубине
    cls: str
    zone: Zone
    pan: float  # -1 (слева) .. 1 (справа) — для панорамы звука
    distance: float  # метры
    urgency: Urgency
    approach: float  # скорость сближения, м/с (> 0 — приближается)
    ttc: float | None  # время до столкновения, с (если приближается)
    moving: bool  # сближается быстрее шага -> движется сам
    conf: float
    box: tuple[float, float, float, float]  # x1, y1, x2, y2 в долях кадра (0..1)
