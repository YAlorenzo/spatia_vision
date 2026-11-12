"""Скорость сближения и время до столкновения по истории дистанции объекта.

Считаем ОТНОСИТЕЛЬНОЕ сближение: неважно, идёт ли пользователь к столбу или
машина едет к пользователю — опасно само сближение. Если же сближение быстрее
скорости шага, объект точно движется сам (флаг moving).
"""
from collections import deque
from dataclasses import dataclass

import numpy as np

from .config import Settings


@dataclass
class Motion:
    approach_mps: float  # > 0 — приближается, < 0 — удаляется
    ttc_s: float | None  # время до столкновения, если приближается
    moving: bool  # сближается быстрее шага -> движется сам


STILL = Motion(0.0, None, False)


class MotionEstimator:
    def __init__(self, s: Settings):
        self.s = s
        self.history: dict[int, deque[tuple[float, float]]] = {}
        self.last_seen: dict[int, float] = {}

    def reset(self) -> None:
        self.history.clear()
        self.last_seen.clear()

    def update(self, track_id: int | None, t: float, distance_m: float) -> Motion:
        if track_id is None:
            return STILL
        h = self.history.setdefault(track_id, deque())
        h.append((t, distance_m))
        while h and t - h[0][0] > self.s.motion_window_s:
            h.popleft()
        self.last_seen[track_id] = t
        self._gc(t)

        # Далёкие объекты не оцениваем: шум глубины там больше реального движения
        if distance_m > self.s.motion_max_range_m or len(h) < 4 or h[-1][0] - h[0][0] < 0.5:
            return STILL
        ts = np.array([p[0] for p in h])
        ds = np.array([p[1] for p in h])
        slope = float(np.polyfit(ts - ts[0], ds, 1)[0])  # м/с, < 0 — дистанция уменьшается
        approach = -slope
        # Шум дистанции растёт с расстоянием -> и порог тоже
        noise = self.s.motion_noise_frac * distance_m
        ttc = distance_m / approach if approach > max(0.3, noise / 2) else None
        moving = approach > max(self.s.moving_speed_mps, noise)
        return Motion(round(approach, 2), None if ttc is None else round(ttc, 1), moving)

    def _gc(self, t: float) -> None:
        stale = [k for k, seen in self.last_seen.items() if t - seen > 3 * self.s.motion_window_s]
        for k in stale:
            self.history.pop(k, None)
            self.last_seen.pop(k, None)
