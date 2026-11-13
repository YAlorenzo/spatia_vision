"""Совет, с какой стороны обойти препятствие.

Для нескольких направлений в поле зрения камеры (bearing, градусы по земле: < 0 левее,
> 0 правее) считается, насколько свободно, если пойти туда: коридор шириной с человека
и расстояние до первого препятствия в нём. Препятствия — точки по карте глубины
(всё, что выше пола) плюс найденные детектором люди/машины/животные.

Обход главной опасности — ближайшее к прямому направление, где свободно заметно дальше
самого препятствия. Камера телефона вертикально видит по горизонтали всего ~40°, поэтому
часто прохода в кадре нет ("none") — тогда клиент просит повернуть телефон и осмотреться.
"""
import math

import numpy as np

from .config import Settings
from collections import Counter, deque

from .schemas import Bypass, TrackedObject


def clearance(points: np.ndarray | None, objects: list[TrackedObject], half_fov_deg: float,
              focal: float, s: Settings) -> tuple[list[float], list[float]]:
    """points — (N, 2) препятствия на земле: X вбок, Z вперёд."""
    pts = [points] if points is not None and len(points) else []
    for o in objects:
        if o.kind == "obstacle" or o.forward_m > s.guide_range_m:
            continue
        # Объект детектора — отрезок поперёк (по ширине рамки) на его дистанции
        x1, _, x2, _ = o.detection.box
        half_w = max(0.2, (x2 - x1) / 2 * o.distance.smoothed_m / focal)
        x = math.copysign(o.lateral_m, o.bearing_deg)
        xs = np.linspace(x - half_w, x + half_w, 7)
        pts.append(np.stack([xs, np.full_like(xs, o.forward_m)], axis=1))
    allp = np.concatenate(pts) if pts else np.zeros((0, 2))
    allp = allp[(allp[:, 1] > 0.1) & (allp[:, 1] < s.guide_range_m)]

    # Направления внутри кадра (у самого края коридор вблизи не виден — отступаем)
    lim = max(0.0, half_fov_deg - s.guide_edge_margin_deg)
    n = max(1, int(lim // s.guide_step_deg))
    bearings = [i * s.guide_step_deg for i in range(-n, n + 1)]
    free: list[float] = []
    half = s.corridor_half_width_m
    for b in bearings:
        r = math.radians(b)
        ux, uz = math.sin(r), math.cos(r)
        along = allp[:, 0] * ux + allp[:, 1] * uz
        across = np.abs(allp[:, 0] * uz - allp[:, 1] * ux)
        hit = (along > 0) & (across < half)
        free.append(round(min(float(along[hit].min()), s.guide_range_m) if hit.any() else s.guide_range_m, 1))
    return [float(b) for b in bearings], free


class BypassAdvisor:
    """Сторона обхода главной опасности, сглаженная по нескольким кадрам (чтобы не прыгала)."""

    def __init__(self, s: Settings):
        self.s = s
        self.recent: deque[Bypass] = deque(maxlen=5)

    def reset(self) -> None:
        self.recent.clear()

    def update(self, primary: TrackedObject | None, bearings: list[float], free: list[float]) -> Bypass | None:
        s = self.s
        if primary is None or not primary.in_path or primary.moving:
            self.recent.clear()
            return None
        need = min(s.guide_range_m, max(3.5, primary.forward_m + s.bypass_extra_m))
        ok = [f >= need for f in free]
        best: float | None = None
        for i, b in enumerate(bearings):
            if abs(b) < s.bypass_min_deg or not ok[i]:
                continue
            # Надёжнее, если свободно и соседнее направление с той же стороны (не щель в 1 луч)
            j = i + (1 if b > 0 else -1)
            k = i - (1 if b > 0 else -1)
            if not ((0 <= j < len(ok) and ok[j]) or (0 <= k < len(ok) and ok[k] and abs(bearings[k]) >= s.bypass_min_deg)):
                continue
            if best is None or abs(b) < abs(best):
                best = b
        self.recent.append("none" if best is None else "right" if best > 0 else "left")
        return Counter(self.recent).most_common(1)[0][0]
