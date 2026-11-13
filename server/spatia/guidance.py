"""Свободные направления — для голосовых подсказок, как обойти препятствие.

Для нескольких направлений в поле зрения камеры (bearing, градусы по земле: < 0 левее,
> 0 правее) считается, насколько свободно, если пойти туда: коридор шириной с человека
и расстояние до первого препятствия в нём. Препятствия — точки по карте глубины
(всё, что выше пола) плюс найденные детектором люди/машины/животные.

Камера телефона вертикально видит по горизонтали всего ~40°, поэтому направления —
только внутри кадра; остальное клиент "собирает", когда человек поворачивает телефон
(и запоминает по датчику ориентации).
"""
import math

import numpy as np

from .config import Settings
from .schemas import Clearance, TrackedObject


def clearance(points: np.ndarray | None, objects: list[TrackedObject], half_fov_deg: float,
              focal: float, s: Settings) -> Clearance:
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
    return Clearance(bearings=[float(b) for b in bearings], free=free, max=s.guide_range_m)
