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
    bearing_deg: float = 0.0  # угол на объект: < 0 слева, > 0 справа
    lateral_m: float = 0.0  # смещение вбок от оси движения
    forward_m: float = 0.0  # расстояние вперёд по оси движения
    approach_mps: float = 0.0  # относительное сближение
    vx_mps: float = 0.0  # относительная скорость вбок (вправо > 0)
    vz_mps: float = 0.0  # относительная скорость вперёд (от пользователя > 0)
    motion_valid: bool = False
    own_speed_mps: float = 0.0  # собственная скорость к пользователю (за вычетом его движения)
    in_path: bool = False  # в коридоре движения
    ttc_s: float | None = None  # эффективное время до столкновения (только для угроз)
    moving: bool = False  # движется сам
    threat: bool = False
    primary: bool = False  # главная опасность кадра


@dataclass
class FrameDebug:
    """Внутренние данные для визуализации/отладки — клиенту не отправляются."""
    objects: list[TrackedObject] = field(default_factory=list)
    depth_map: "object | None" = None  # np.ndarray, метры (до автокалибровки)
    depth_scale: float = 1.0  # текущая поправка масштаба глубины
    free_space: "object | None" = None  # free_space.FreeSpaceDebug
    ego_speed: float = 0.0  # оценка скорости пользователя вперёд, м/с
    timings_ms: dict[str, float] = field(default_factory=dict)


class Obstacle(BaseModel):
    id: int | None  # для препятствий по глубине: -1/-2/-3 (зона слева/прямо/справа)
    kind: Kind  # person / vehicle / animal — по детектору; obstacle — по глубине
    cls: str
    zone: Zone
    pan: float  # -1 (слева) .. 1 (справа) — для панорамы звука
    distance: float  # метры
    urgency: Urgency
    bearing: float  # угол на объект, градусы: < 0 слева, > 0 справа (для 3D-звука)
    in_path: bool  # в коридоре движения (врежешься, если идти прямо)
    approach: float  # относительная скорость сближения, м/с (> 0 — приближается)
    own_speed: float  # собственная скорость к пользователю (за вычетом его ходьбы), м/с
    ttc: float | None  # эффективное время до столкновения, с (только для угроз)
    moving: bool  # движется сам
    threat: bool  # опасно: в коридоре или едет на пользователя
    primary: bool  # ГЛАВНАЯ опасность — только о ней звук; остальное приглушается
    conf: float
    box: tuple[float, float, float, float]  # x1, y1, x2, y2 в долях кадра (0..1)
