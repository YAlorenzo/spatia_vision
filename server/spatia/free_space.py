"""Препятствия без классов — по карте глубины.

Идея: переводим карту глубины в 3D-облако точек (зная угол обзора камеры),
находим плоскость пола (RANSAC), и всё, что заметно возвышается над полом
и находится ближе N метров, считаем препятствием. Так ловятся деревья, столбы,
стены, мебель — что угодно, без детектора. Пиксели, уже объяснённые детектором
(люди, машины), исключаются, чтобы не дублировать.

Результат — не больше одного препятствия на зону (слева / прямо / справа):
ближайшее. Этого достаточно для звука и не создаёт шума.
"""
import math
from dataclasses import dataclass

import cv2
import numpy as np

from .config import Settings
from .distance import focal_px
from .schemas import Detection, Zone

ZONES: tuple[Zone, ...] = ("left", "center", "right")


@dataclass
class GroundPlane:
    normal: np.ndarray  # единичная нормаль, смотрит "вверх" (к камере)
    height: float  # высота камеры над полом, м

    def height_above(self, pts: np.ndarray) -> np.ndarray:
        return pts @ self.normal + self.height

    @property
    def pitch_deg(self) -> float:
        """Наклон камеры вниз (0 = смотрит горизонтально). Камера смотрит вниз ->
        вектор "вверх" в её координатах получает отрицательную Z-составляющую."""
        return math.degrees(math.asin(float(np.clip(-self.normal[2], -1, 1))))


@dataclass
class GenericObstacle:
    zone: Zone
    distance_m: float
    box: tuple[int, int, int, int]  # пиксели полного кадра
    area: float  # доля кадра


@dataclass
class FreeSpaceDebug:
    ground: np.ndarray | None = None  # bool-маска на сетке
    obstacles: np.ndarray | None = None  # bool-маска на сетке
    plane: GroundPlane | None = None


def _fit_plane(pts: np.ndarray, s: Settings, rng: np.random.Generator) -> GroundPlane | None:
    """RANSAC: плоскость пола среди точек нижней части кадра."""
    n = len(pts)
    if n < 50:
        return None
    min_up = math.cos(math.radians(s.ground_max_tilt_deg))
    tol = 0.04 + 0.03 * pts[:, 2]  # шум глубины растёт с расстоянием
    best, best_count = None, 0
    for _ in range(s.ground_iterations):
        a, b, c = pts[rng.choice(n, 3, replace=False)]
        normal = np.cross(b - a, c - a)
        norm = np.linalg.norm(normal)
        if norm < 1e-6:
            continue
        normal /= norm
        if normal[1] > 0:  # ось Y камеры смотрит вниз -> нормаль пола должна иметь y < 0
            normal = -normal
        if -normal[1] < min_up:  # слишком наклонённая плоскость — это стена, не пол
            continue
        d = -normal @ a
        count = int((np.abs(pts @ normal + d) < tol).sum())
        if count > best_count:
            best, best_count = (normal, d), count
    if best is None or best_count < 0.25 * n:
        return None

    # Уточнение: МНК по всем инлаерам
    normal, d = best
    inl = pts[np.abs(pts @ normal + d) < tol]
    centroid = inl.mean(axis=0)
    _, _, vt = np.linalg.svd(inl - centroid, full_matrices=False)
    normal = vt[2]
    if normal[1] > 0:
        normal = -normal
    d = -normal @ centroid
    if d <= 0.3:  # камера ниже 30 см над "полом" — ошибка подгонки
        return None
    return GroundPlane(normal=normal, height=float(d))


class FreeSpaceAnalyzer:
    """Состояние на сессию: плоскость пола сглаживается между кадрами."""

    def __init__(self, s: Settings):
        self.s = s
        self.plane: GroundPlane | None = None
        self.plane_age = 0
        self.rng = np.random.default_rng(0)

    def reset(self) -> None:
        self.plane = None
        self.plane_age = 0

    def _update_plane(self, new: GroundPlane | None) -> GroundPlane | None:
        if new is None:
            self.plane_age += 1
            if self.plane_age > self.s.ground_ttl_frames:
                self.plane = None
            return self.plane
        if self.plane is None:
            self.plane = new
        else:
            a = self.s.ground_smoothing
            normal = (1 - a) * self.plane.normal + a * new.normal
            self.plane = GroundPlane(normal / np.linalg.norm(normal), (1 - a) * self.plane.height + a * new.height)
        self.plane_age = 0
        return self.plane

    def analyze(
        self, depth_m: np.ndarray, detections: list[Detection]
    ) -> tuple[list[GenericObstacle], FreeSpaceDebug]:
        s = self.s
        H, W = depth_m.shape
        step = max(1, W // s.generic_grid_width)
        z = depth_m[step // 2::step, step // 2::step]
        gh, gw = z.shape
        us = (np.arange(gw) * step + step // 2).astype(np.float32)
        vs = (np.arange(gh) * step + step // 2).astype(np.float32)
        f = focal_px(W, s.camera_hfov_deg)
        x = (us[None, :] - W / 2) * z / f
        y = (vs[:, None] - H / 2) * z / f
        pts = np.stack([x, y, z], axis=-1)  # (gh, gw, 3): X вправо, Y вниз, Z вперёд

        # Кандидаты в пол: нижние 45% кадра, не дальше 10 м
        cand = np.zeros((gh, gw), bool)
        cand[int(gh * 0.55):] = True
        cand &= (z > 0.2) & (z < 10)
        plane = self._update_plane(_fit_plane(pts[cand], s, self.rng))
        dbg = FreeSpaceDebug(plane=plane)
        if plane is None:
            return [], dbg

        h = plane.height_above(pts.reshape(-1, 3)).reshape(gh, gw)
        dbg.ground = np.abs(h) < 0.08 + 0.03 * z
        obst = (h > s.generic_min_height_m) & (h < s.generic_max_height_m) & (z > 0.2) & (z < s.generic_max_range_m)

        # Убираем то, что уже нашёл детектор (люди, машины, животные)
        for det in detections:
            x1, y1, x2, y2 = det.box
            obst[max(0, y1 // step):y2 // step + 1, max(0, x1 // step):x2 // step + 1] = False

        # Чистим шум: морфология + минимальная площадь компоненты
        m = cv2.morphologyEx(obst.astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        dbg.obstacles = m.astype(bool)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        min_cells = s.generic_min_area * gh * gw

        nearest: dict[Zone, GenericObstacle] = {}
        for i in range(1, count):
            if stats[i, cv2.CC_STAT_AREA] < min_cells:
                continue
            cells = labels == i
            cols = np.nonzero(cells.any(axis=0))[0]
            # Компонента может тянуться через несколько зон — относим к каждой
            for zi, zone in enumerate(ZONES):
                lo, hi = gw * zi / 3, gw * (zi + 1) / 3
                zone_cols = cols[(cols >= lo) & (cols < hi)]
                if len(zone_cols) == 0:
                    continue
                part = cells[:, int(lo):int(math.ceil(hi))]
                if part.sum() < min_cells / 2:
                    continue
                zdist = float(np.percentile(z[:, int(lo):int(math.ceil(hi))][part], 10))
                if zone in nearest and nearest[zone].distance_m <= zdist:
                    continue
                rows = np.nonzero(part.any(axis=1))[0]
                box = (
                    int(zone_cols.min() * step),
                    int(rows.min() * step),
                    int(min(W, (zone_cols.max() + 1) * step)),
                    int(min(H, (rows.max() + 1) * step)),
                )
                nearest[zone] = GenericObstacle(zone, zdist, box, float(part.sum()) / (gh * gw))
        return [nearest[z] for z in ZONES if z in nearest], dbg
