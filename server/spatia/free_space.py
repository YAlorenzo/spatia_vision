"""Препятствия без классов — по карте глубины.

Идея: переводим карту глубины в 3D-облако точек (зная угол обзора камеры),
находим плоскость пола (RANSAC), и всё, что заметно возвышается над полом
и находится ближе N метров, считаем препятствием. Так ловятся деревья, столбы,
стены, мебель — что угодно, без детектора. Пиксели, уже объяснённые детектором
(люди, машины), исключаются, чтобы не дублировать.

Зоны считаются в МЕТРАХ, а не по третям кадра:
  center — коридор движения (|X| < corridor_half_width): то, во что врежешься, если идти прямо;
  left / right — полосы сбоку до generic_side_max_m.
На каждую зону — одно ближайшее препятствие.
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
    measured: bool = True  # False — априорная оценка (пол ещё не видели)

    def height_above(self, pts: np.ndarray) -> np.ndarray:
        return pts @ self.normal + self.height

    @property
    def pitch_deg(self) -> float:
        """Наклон камеры вниз (0 = смотрит горизонтально). Камера смотрит вниз ->
        вектор "вверх" в её координатах получает отрицательную Z-составляющую."""
        return math.degrees(math.asin(float(np.clip(-self.normal[2], -1, 1))))

    @classmethod
    def prior(cls, height: float, pitch_deg: float) -> "GroundPlane":
        p = math.radians(pitch_deg)
        return cls(np.array([0.0, -math.cos(p), -math.sin(p)]), height, measured=False)


@dataclass
class GenericObstacle:
    zone: Zone
    distance_m: float  # расстояние ВПЕРЁД (по оси камеры) до ближайшей точки
    lateral_m: float  # смещение ближайшей точки вбок от оси (по модулю)
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
    if -normal[1] < min_up:
        return None
    d = -normal @ centroid
    if not 0.3 < d < 3.0:  # камера ниже 30 см или выше 3 м над "полом" — ошибка подгонки
        return None
    return GroundPlane(normal=normal, height=float(d))


class FreeSpaceAnalyzer:
    """Состояние на сессию: плоскость пола сглаживается и НЕ теряется между кадрами."""

    def __init__(self, s: Settings):
        self.s = s
        self.plane: GroundPlane = GroundPlane.prior(s.ground_prior_height_m, s.ground_prior_pitch_deg)
        self.rng = np.random.default_rng(0)

    def reset(self) -> None:
        self.plane = GroundPlane.prior(self.s.ground_prior_height_m, self.s.ground_prior_pitch_deg)

    def _update_plane(self, new: GroundPlane | None) -> GroundPlane:
        # Не нашли пол (например, вплотную к стене — пола в кадре нет) — держим последний:
        # телефон в руке держится примерно одинаково, а без пола стену не отличить.
        if new is None:
            return self.plane
        if not self.plane.measured:
            self.plane = new
        else:
            a = self.s.ground_smoothing
            normal = (1 - a) * self.plane.normal + a * new.normal
            self.plane = GroundPlane(normal / np.linalg.norm(normal), (1 - a) * self.plane.height + a * new.height)
        return self.plane

    def analyze(
        self, depth_m: np.ndarray, detections: list[Detection]
    ) -> tuple[list[GenericObstacle], FreeSpaceDebug]:
        s = self.s
        H, W = depth_m.shape
        step = max(1, max(W, H) // s.generic_grid_width)
        z = depth_m[step // 2::step, step // 2::step]
        gh, gw = z.shape
        us = (np.arange(gw) * step + step // 2).astype(np.float32)
        vs = (np.arange(gh) * step + step // 2).astype(np.float32)
        f = focal_px(W, H, s.camera_fov_deg)
        x = (us[None, :] - W / 2) * z / f
        y = (vs[:, None] - H / 2) * z / f
        pts = np.stack([x, y, z], axis=-1)  # (gh, gw, 3): X вправо, Y вниз, Z вперёд

        # Кандидаты в пол: нижние 45% кадра, не дальше 10 м
        cand = np.zeros((gh, gw), bool)
        cand[int(gh * 0.55):] = True
        cand &= (z > 0.2) & (z < 10)
        plane = self._update_plane(_fit_plane(pts[cand], s, self.rng))
        dbg = FreeSpaceDebug(plane=plane)

        h = plane.height_above(pts.reshape(-1, 3)).reshape(gh, gw)
        dbg.ground = np.abs(h) < 0.08 + 0.03 * z
        obst = (h > s.generic_min_height_m) & (h < s.generic_max_height_m) & (z > 0.2) & (z < s.generic_max_range_m)

        # Убираем то, что уже нашёл детектор (люди, машины, животные)
        for det in detections:
            x1, y1, x2, y2 = det.box
            obst[max(0, y1 // step):y2 // step + 1, max(0, x1 // step):x2 // step + 1] = False

        # Чистим шум: минимальная площадь компоненты
        m = obst.astype(np.uint8)
        count, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        min_cells = s.generic_min_area * gh * gw
        keep = np.zeros_like(obst)
        for i in range(1, count):
            if stats[i, cv2.CC_STAT_AREA] >= min_cells:
                keep |= labels == i
        dbg.obstacles = keep
        if not keep.any():
            return [], dbg

        # Зоны в метрах: коридор движения и полосы по бокам
        half = s.corridor_half_width_m
        zone_masks = {
            "center": keep & (np.abs(x) < half),
            "left": keep & (x <= -half) & (x > -s.generic_side_max_m),
            "right": keep & (x >= half) & (x < s.generic_side_max_m),
        }
        result: list[GenericObstacle] = []
        for zone in ZONES:
            zm = zone_masks[zone]
            # В узком коридоре вдали мало ячеек — порог площади для него мягче
            if zm.sum() < (min_cells / 4 if zone == "center" else min_cells / 2):
                continue
            zd = z[zm]
            dist = float(np.percentile(zd, 10))
            near = zm & (z <= np.percentile(zd, 30))  # ближняя часть — для рамки и смещения
            rows, cols = np.nonzero(near)
            box = (
                int(cols.min() * step),
                int(rows.min() * step),
                int(min(W, (cols.max() + 1) * step)),
                int(min(H, (rows.max() + 1) * step)),
            )
            lateral = float(np.min(np.abs(x[near])))
            result.append(GenericObstacle(zone, dist, lateral, box, float(zm.sum()) / (gh * gw)))
        return result, dbg
