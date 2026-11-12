"""Дистанция до объекта: модель глубины + геометрия + сглаживание во времени."""
import math

import numpy as np

from .config import Settings
from .schemas import Detection


def focal_px(frame_w: int, frame_h: int, fov_long_deg: float) -> float:
    """Фокусное расстояние в пикселях. Угол обзора задаётся по ДЛИННОЙ стороне кадра,
    поэтому результат одинаков для горизонтального и вертикального телефона."""
    return (max(frame_w, frame_h) / 2) / math.tan(math.radians(fov_long_deg) / 2)


def bearing_deg(x_px: float, frame_w: int, frame_h: int, fov_long_deg: float) -> float:
    """Угол на точку по горизонтали: 0 — прямо, < 0 — слева, > 0 — справа."""
    return math.degrees(math.atan((x_px - frame_w / 2) / focal_px(frame_w, frame_h, fov_long_deg)))


def sample_depth(depth_map: np.ndarray, box: tuple[int, int, int, int], s: Settings) -> float | None:
    # Внутренняя часть рамки (без краёв, где фон), затем перцентиль —
    # ближние пиксели принадлежат объекту, дальние — фону за ним.
    h, w = depth_map.shape
    x1, y1, x2, y2 = box
    bw, bh = x2 - x1, y2 - y1
    ix1, ix2 = x1 + int(bw * 0.2), x2 - int(bw * 0.2)
    iy1, iy2 = y1 + int(bh * 0.15), y2 - int(bh * 0.1)
    patch = depth_map[max(0, iy1):min(h, iy2), max(0, ix1):min(w, ix2)]
    if patch.size < 4:
        patch = depth_map[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
    if patch.size == 0:
        return None
    return float(np.percentile(patch, s.depth_percentile))


def geometry_distance(det: Detection, frame_hw: tuple[int, int], s: Settings) -> float | None:
    """distance = f * H_real / h_px. Только если объект целиком в кадре по вертикали."""
    real_h = s.known_heights.get(det.cls)
    if real_h is None:
        return None
    fh, fw = frame_hw
    x1, y1, x2, y2 = det.box
    margin = 0.01 * fh
    if y1 <= margin or y2 >= fh - margin:  # обрезан сверху/снизу — высота занижена
        return None
    box_h = y2 - y1
    if box_h < 12:
        return None
    return focal_px(fw, fh, s.camera_fov_deg) * real_h / box_h


def fuse(depth_m: float | None, geom_m: float | None, s: Settings) -> float | None:
    if depth_m is None:
        return geom_m
    if geom_m is None or not s.use_geometry:
        return depth_m
    # Ошибки геометрии (перекрытие, обрезка, сидящий человек) почти всегда делают
    # объект ДАЛЬШЕ истины. Поэтому при расхождении плавно смещаем вес к меньшей
    # оценке — физически обосновано и безопаснее. Плавно, чтобы не было скачков.
    lo, hi = (math.log(v) for v in s.disagreement_range)
    r = math.log(depth_m / geom_m)  # > 0: геометрия ближе
    t = min(max((abs(r) - lo) / (hi - lo), 0.0), 1.0)
    wg0 = s.geometry_weight
    wg = wg0 + (1 - wg0) * t if r > 0 else wg0 * (1 - t)
    return math.exp((1 - wg) * math.log(depth_m) + wg * math.log(geom_m))


class DepthScaleCalibrator:
    """Автокалибровка масштаба модели глубины по объектам известного размера.

    Метрические модели глубины ошибаются в масштабе, если камера отличается
    от обучающих данных (FOV, высота съёмки). Объекты с известной высотой
    (люди, машины) дают "линейку": scale = geometry / depth. Поправка
    сглаживается во времени и применяется ко всем объектам кадра.
    """

    def __init__(self, s: Settings):
        self.s = s
        self.log_scale = 0.0
        self.samples = 0

    def reset(self) -> None:
        self.log_scale = 0.0
        self.samples = 0

    @property
    def scale(self) -> float:
        return math.exp(self.log_scale) if self.s.auto_scale else 1.0

    def update(self, pairs: list[tuple[float, float]]) -> None:
        """pairs: (depth_m_без_поправки, geometry_m) для объектов текущего кадра."""
        if not self.s.auto_scale or not pairs:
            return
        lo, hi = self.s.auto_scale_limits
        ratios = sorted(math.log(g / d) for d, g in pairs if d > 0 and g > 0)
        frame_log = ratios[len(ratios) // 2]  # медиана по кадру
        frame_log = min(max(frame_log, math.log(lo)), math.log(hi))
        # Быстрый старт по первым кадрам, затем медленная адаптация
        a = 1 / (self.samples + 1) if self.samples < 10 else self.s.auto_scale_alpha
        self.log_scale = a * frame_log + (1 - a) * self.log_scale
        self.samples += 1


class DistanceSmoother:
    """EMA по track_id в лог-пространстве (одинаково плавно для 1 м и 10 м)."""

    def __init__(self, s: Settings):
        self.s = s
        self.state: dict[int, tuple[float, int]] = {}  # id -> (log_dist, last_frame)

    def reset(self) -> None:
        self.state.clear()

    def update(self, track_id: int | None, value: float, frame_idx: int) -> float:
        if not self.s.smoothing or track_id is None:
            return value
        prev = self.state.get(track_id)
        v = math.log(value)
        if prev is not None and frame_idx - prev[1] <= self.s.track_ttl_frames:
            a = self.s.smoothing_alpha
            # Объект резко приблизился — реагируем быстрее (важно для безопасности)
            if v < prev[0] - math.log(1.25):
                a = min(1.0, a * 2)
            v = a * v + (1 - a) * prev[0]
        self.state[track_id] = (v, frame_idx)
        self._gc(frame_idx)
        return math.exp(v)

    def _gc(self, frame_idx: int) -> None:
        ttl = self.s.track_ttl_frames
        stale = [k for k, (_, f) in self.state.items() if frame_idx - f > ttl]
        for k in stale:
            del self.state[k]
