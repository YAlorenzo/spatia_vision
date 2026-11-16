"""Совет, с какой стороны обойти препятствие.

Человек обходит препятствие не по лучу под углом, а шагом в сторону и дальше параллельно.
Поэтому проверяются ПОЛОСЫ — параллельные проходы шириной с человека, сдвинутые влево и
вправо на 0.6…1.8 м. Полоса годится для обхода, если рядом с препятствием (от чуть ближе
него до метра за ним):
  - в ней нет препятствий (точки карты глубины выше пола, найденные люди/машины);
  - в ней ВИДЕН пол — то, чего камера не видит, свободным не считается.
Выбирается ближайшая к прямому пути годная полоса; сторона сглаживается по нескольким кадрам.

Камера телефона вертикально видит узко: в 1.5 м — полосу шириной ~1 м. Если сбоку пола
не видно, ответ "none" — клиент просит повернуть телефон и осмотреться.
"""
from collections import Counter, deque

import numpy as np

from .config import Settings
from .schemas import Bypass, TrackedObject


def lanes(obstacles: np.ndarray | None, ground: np.ndarray | None, objects: list[TrackedObject],
          primary: TrackedObject, focal: float, s: Settings) -> tuple[list[float], list[str]]:
    """Состояние полос для обхода primary. obstacles / ground — (N, 2): X вбок, Z вперёд по земле.
    Возвращает (сдвиги полос в метрах, состояние каждой: free / blocked / unseen)."""
    pts = [obstacles] if obstacles is not None and len(obstacles) else []
    for o in objects:
        if o.kind == "obstacle":
            continue
        # Объект детектора — отрезок поперёк (по ширине рамки) на его дистанции
        x1, _, x2, _ = o.detection.box
        half_w = max(0.25, (x2 - x1) / 2 * o.distance.smoothed_m / focal)
        x = float(np.copysign(o.lateral_m, o.bearing_deg))
        xs = np.linspace(x - half_w, x + half_w, 9)
        pts.append(np.stack([xs, np.full_like(xs, o.forward_m)], axis=1))
    obst = np.concatenate(pts) if pts else np.zeros((0, 2))
    grd = ground if ground is not None else np.zeros((0, 2))

    d = primary.forward_m
    z0, z1 = max(0.3, d - s.bypass_before_m), d + s.bypass_beyond_m
    obst = obst[obst[:, 1] < z1]  # всё, что ближе конца обхода (в т.ч. перед препятствием)
    grd = grd[(grd[:, 1] > z0) & (grd[:, 1] < z1)]

    n = int(round(s.bypass_max_shift_m / s.bypass_step_m))
    offsets = [round(i * s.bypass_step_m, 2) for i in range(-n, n + 1)]
    state: list[str] = []
    for x in offsets:
        if len(obst) and (np.abs(obst[:, 0] - x) < s.bypass_half_width_m).any():
            state.append("blocked")
            continue
        g = grd[np.abs(grd[:, 0] - x) < s.bypass_half_width_m]
        # Пол должен быть виден и рядом с препятствием, и за ним (а не одно пятно у ног)
        seen = len(g) >= s.bypass_min_ground_cells and g[:, 1].max() >= d + 0.3 * s.bypass_beyond_m
        state.append("free" if seen else "unseen")
    return offsets, state


class BypassAdvisor:
    """Сторона обхода главной опасности, сглаженная по нескольким кадрам (чтобы не прыгала)."""

    def __init__(self, s: Settings):
        self.s = s
        self.recent: deque[Bypass] = deque(maxlen=5)
        self.side: Bypass | None = None

    def reset(self) -> None:
        self.recent.clear()

    def update(self, primary: TrackedObject | None, offsets: list[float], state: list[str],
               course_deg: float | None = None) -> Bypass | None:
        """course_deg — куда человеку нужно (градусы от оси камеры, > 0 правее); None — курс не задан."""
        if primary is None or not primary.in_path or primary.moving:
            self.recent.clear()
            self.side = None
            return None
        free = [x for x, st in zip(offsets, state) if st == "free" and abs(x) >= self.s.bypass_min_shift_m]
        best = min(free, key=abs, default=None)
        side: Bypass = "none" if best is None else "right" if best > 0 else "left"
        # Свободно с обеих сторон — не прыгаем: держим прежнюю сторону, пока она не намного хуже
        if best is not None and self.side in ("left", "right") and self.side != side:
            same = [x for x in free if (x > 0) == (self.side == "right")]
            if same and min(abs(x) for x in same) <= abs(best) + self.s.bypass_keep_side_m:
                side = self.side
        # Задан курс — обходим с той стороны, куда человеку и так нужно (если она не намного хуже):
        # иначе обход уводит в сторону от цели
        if best is not None and course_deg is not None and abs(course_deg) >= self.s.bypass_course_min_deg:
            want_right = course_deg > 0
            toward = [x for x in free if (x > 0) == want_right]
            if toward and min(abs(x) for x in toward) <= abs(best) + self.s.bypass_course_extra_m:
                side = "right" if want_right else "left"
        self.recent.append(side)
        self.side = Counter(self.recent).most_common(1)[0][0]
        return self.side
