"""Скорость сближения по истории дистанции + собственная скорость пользователя.

approach — ОТНОСИТЕЛЬНОЕ сближение (идёт ли пользователь к столбу или машина к нему).
Чтобы понять, движется ли объект САМ, из него вычитается скорость пользователя
(EgoMotion), оценённая по неподвижным препятствиям: если все стены и деревья
"приближаются" со скоростью 1.2 м/с — это пользователь идёт вперёд; если "удаляются" —
пользователь отходит назад. Так стоящая машина не считается едущей, когда ты к ней идёшь,
а при отходе назад ничего не "приближается".
"""
from collections import deque
from dataclasses import dataclass

import numpy as np

from .config import Settings


@dataclass
class Motion:
    approach_mps: float  # > 0 — приближается, < 0 — удаляется (относительно пользователя)
    vx_mps: float  # относительная скорость вбок (вправо > 0)
    vz_mps: float  # относительная скорость вперёд (от пользователя > 0)
    valid: bool  # хватило истории для оценки


STILL = Motion(0.0, 0.0, 0.0, False)


class MotionEstimator:
    def __init__(self, s: Settings):
        self.s = s
        # история: (время, дистанция, X вбок, Z вперёд)
        self.history: dict[int, deque[tuple[float, float, float, float]]] = {}
        self.last_seen: dict[int, float] = {}

    def reset(self) -> None:
        self.history.clear()
        self.last_seen.clear()

    def update(self, track_id: int | None, t: float, distance_m: float, x_m: float, z_m: float) -> Motion:
        """x_m, z_m — положение объекта на земле относительно пользователя (вбок, вперёд)."""
        if track_id is None:
            return STILL
        h = self.history.setdefault(track_id, deque())
        # Скачок дистанции — это уже другой объект (смена ближайшего препятствия, ошибка трекера)
        if h and abs(distance_m - h[-1][1]) > self.s.motion_jump_frac * max(h[-1][1], 1.0):
            h.clear()
        h.append((t, distance_m, x_m, z_m))
        while h and t - h[0][0] > self.s.motion_window_s:
            h.popleft()
        self.last_seen[track_id] = t
        self._gc(t)

        # Далёкие объекты не оцениваем: шум глубины там больше реального движения
        if distance_m > self.s.motion_max_range_m or len(h) < 4 or h[-1][0] - h[0][0] < 0.5:
            return STILL
        arr = np.array(h)
        ts = arr[:, 0] - arr[0, 0]
        slope = lambda col: float(np.polyfit(ts, arr[:, col], 1)[0])  # noqa: E731
        return Motion(round(-slope(1), 2), round(slope(2), 2), round(slope(3), 2), True)

    def _gc(self, t: float) -> None:
        stale = [k for k, seen in self.last_seen.items() if t - seen > 3 * self.s.motion_window_s]
        for k in stale:
            self.history.pop(k, None)
            self.last_seen.pop(k, None)


class EgoMotion:
    """Скорость пользователя вперёд (м/с): визуальная одометрия по полу.

    Точки асфальта/пола отслеживаются между кадрами (оптический поток Лукаса-Канаде).
    Плоскость пола известна, поэтому каждую точку можно перевести в метры (пересечение
    луча камеры с полом) — без модели глубины. Если пол "уезжает" к камере на 1 м за
    секунду, пользователь идёт вперёд со скоростью 1 м/с; если от камеры — пятится назад.

    Итог — медиана "голосов": пол (двойной вес) + кажущееся сближение препятствий и машин.
    """

    def __init__(self, s: Settings):
        self.s = s
        self.speed = 0.0
        self.prev: tuple[np.ndarray, float] | None = None  # (серый кадр, время)
        self.source = "none"

    def reset(self) -> None:
        self.speed = 0.0
        self.prev = None

    def _ground_points(self, pts: np.ndarray, plane, focal: float, w: int, h: int) -> np.ndarray:
        """Пиксели -> 3D-точки на плоскости пола (NaN, если луч не попадает в пол)."""
        rays = np.stack([(pts[:, 0] - w / 2) / focal, (pts[:, 1] - h / 2) / focal, np.ones(len(pts))], axis=1)
        denom = rays @ plane.normal
        with np.errstate(divide="ignore", invalid="ignore"):
            t = -plane.height / denom
        p = rays * t[:, None]
        p[(t <= 0) | (p[:, 2] > 8) | (p[:, 2] < 0.3)] = np.nan
        return p

    def update(self, gray: np.ndarray, t: float, plane, focal: float,
               exclude: list[tuple[int, int, int, int]], static_approaches: list[float]) -> float:
        import cv2

        h, w = gray.shape
        frame_speed: float | None = None
        if self.prev is not None and plane is not None and plane.measured:
            prev_gray, prev_t = self.prev
            dt = t - prev_t
            if 0.02 < dt < 1.0:
                # Особые точки в нижней части кадра (там пол), без людей/машин
                mask = np.zeros_like(prev_gray)
                mask[int(h * 0.5):] = 255
                for x1, y1, x2, y2 in exclude:
                    mask[max(0, y1):y2, max(0, x1):x2] = 0
                p0 = cv2.goodFeaturesToTrack(prev_gray, 150, 0.01, 8, mask=mask)
                if p0 is not None and len(p0) >= 12:
                    p1, st, _ = cv2.calcOpticalFlowPyrLK(prev_gray, gray, p0, None, winSize=(21, 21), maxLevel=3)
                    ok = st.ravel() == 1
                    shift = float(np.median(np.abs(p1 - p0).reshape(-1, 2)[ok].sum(axis=1))) if ok.any() else 0.0
                    if shift < 0.25 and dt < 0.1:
                        # Кадр-дубликат (видео с повторами кадров): картинка не сдвинулась.
                        # Не обновляем опорный кадр — время накопится до следующего настоящего.
                        return self.speed
                    a = self._ground_points(p0.reshape(-1, 2)[ok], plane, focal, w, h)
                    b = self._ground_points(p1.reshape(-1, 2)[ok], plane, focal, w, h)
                    dz = (a[:, 2] - b[:, 2]) / dt  # точка пола стала ближе -> идём вперёд
                    dz = dz[np.isfinite(dz)]
                    if len(dz) >= 8:
                        frame_speed = float(np.median(dz))
                        self.source = "floor"
        self.prev = (gray, t)

        # Голосование: пол (двойной вес) + кажущееся сближение препятствий и машин.
        # На улице большинство объектов стоит, поэтому медиана = скорость пользователя;
        # одна едущая машина медиану не перетянет, а покачивание телефона — сгладится.
        votes = list(static_approaches)
        if frame_speed is not None:
            votes += [frame_speed, frame_speed]
        frame_speed = float(np.median(votes)) if votes else None
        if frame_speed is None:
            self.speed *= 0.9  # нет опоры — плавно считаем, что стоим
            self.source = "none"
            return self.speed
        frame_speed = max(-2.5, min(2.5, frame_speed))  # быстрее бега — это шум
        a = self.s.ego_smoothing
        self.speed = (1 - a) * self.speed + a * frame_speed
        return self.speed
