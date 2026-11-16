"""Препятствия без классов — по карте глубины. И "земные" оси для всего конвейера.

Идея: переводим карту глубины в 3D-облако точек (зная угол обзора камеры),
находим плоскость пола, и всё, что заметно возвышается над полом и находится
ближе N метров, считаем препятствием. Так ловятся деревья, столбы, стены, мебель —
что угодно, без детектора. Пиксели, уже объяснённые детектором (люди, машины),
исключаются, чтобы не дублировать.

Наклон телефона. Камера редко смотрит строго горизонтально: телефон наклонён вперёд,
завален вбок, экшн-камера смотрит чуть вверх. Поэтому "вперёд" и "вбок" считаются не в
осях камеры, а в ЗЕМНЫХ осях: up — вверх (по гравитации), forward — горизонтальное
направление, куда смотрит камера, right — вправо по земле. Направление "вверх" берётся:
  1. с датчика ориентации телефона (присылает клиент) — точно и сразу;
  2. иначе — из нормали найденной плоскости пола;
  3. иначе — априорная оценка (телефон в руке, наклон ~15° вниз).

Зоны считаются в МЕТРАХ по земле, а не по третям кадра:
  center — коридор движения (|X| < corridor_half_width): то, во что врежешься, если идти прямо;
  left / right — полосы сбоку до generic_side_max_m.
На каждую зону — одно ближайшее препятствие.
"""
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from .config import Settings
from .distance import focal_px
from .schemas import Detection, Zone

ZONES: tuple[Zone, ...] = ("left", "center", "right")
_Z = np.array([0.0, 0.0, 1.0])  # ось камеры "вперёд"
_IMG_UP = np.array([0.0, -1.0, 0.0])  # "вверх по картинке"


@dataclass
class GroundPlane:
    normal: np.ndarray  # единичная нормаль = направление "вверх" в координатах камеры
    height: float  # высота камеры над полом, м
    measured: bool = True  # False — априорная оценка (пол ещё не видели)

    def height_above(self, pts: np.ndarray) -> np.ndarray:
        return pts @ self.normal + self.height

    def axes(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Земные оси в координатах камеры: (right, forward, up)."""
        u = self.normal
        f = _Z - (_Z @ u) * u  # ось камеры, спроецированная на горизонталь
        if np.linalg.norm(f) < 0.3:
            # Камера смотрит почти прямо в пол/небо: "вперёд" — куда смотрит верх картинки
            f = _IMG_UP - (_IMG_UP @ u) * u
        f = f / np.linalg.norm(f)
        return np.cross(f, u), f, u

    def to_ground(self, pts: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """3D-точки камеры -> (X вправо по земле, Z вперёд по земле), метры."""
        r, f, _ = self.axes()
        return pts @ r, pts @ f

    @property
    def pitch_deg(self) -> float:
        """Наклон камеры вниз (0 = смотрит горизонтально, > 0 — вниз)."""
        return math.degrees(math.asin(float(np.clip(-self.normal[2], -1, 1))))

    @property
    def roll_deg(self) -> float:
        """Завал вбок (0 = горизонт ровный)."""
        return math.degrees(math.atan2(float(self.normal[0]), float(-self.normal[1])))

    @classmethod
    def prior(cls, height: float, pitch_deg: float) -> "GroundPlane":
        p = math.radians(pitch_deg)
        return cls(np.array([0.0, -math.cos(p), -math.sin(p)]), height, measured=False)


@dataclass
class GenericObstacle:
    zone: Zone
    distance_m: float  # расстояние ВПЕРЁД по земле до ближайшей точки
    x_m: float  # смещение ближайшей точки вбок по земле (< 0 — слева)
    box: tuple[int, int, int, int]  # пиксели полного кадра
    area: float  # доля кадра
    shape: str = "obstacle"  # по форме: wall (широкое и высокое) / pole (узкое и высокое) / low / obstacle


@dataclass
class FreeSpaceDebug:
    ground: np.ndarray | None = None  # bool-маска на сетке
    obstacles: np.ndarray | None = None  # bool-маска на сетке
    plane: GroundPlane | None = None
    imu: bool = False  # "вверх" взято с датчика телефона
    fit_height: float | None = None  # высота камеры над полом, найденная в ЭТОМ кадре (None — пол не найден)
    points: np.ndarray | None = None  # (N, 2): препятствия на земле — X вбок, Z вперёд (для обхода)
    ground_points: np.ndarray | None = None  # (N, 2): видимый пол на земле (для обхода)
    # Все области препятствий в кадре: (рамка в пикселях, дистанция вперёд, смещение вбок) — для показа и памяти
    components: list[tuple[tuple[int, int, int, int], float, float]] = field(default_factory=list)


def _tolerance(pts: np.ndarray) -> np.ndarray:
    return 0.04 + 0.03 * pts[:, 2]  # шум глубины растёт с расстоянием


def _fit_plane(pts: np.ndarray, s: Settings, rng: np.random.Generator,
               expected_up: np.ndarray | None) -> GroundPlane | None:
    """RANSAC: плоскость пола (нормаль и высота), когда "вверх" неизвестно точно.

    expected_up — прошлая оценка "вверх": новая плоскость должна быть близка к ней
    (иначе это стена или наклонная поверхность). Без неё — ограничение наклона камеры.
    """
    n = len(pts)
    if n < 50:
        return None

    def plausible(normal: np.ndarray) -> bool:
        if expected_up is not None:
            return float(normal @ expected_up) >= math.cos(math.radians(s.ground_max_change_deg))
        return -normal[1] >= math.cos(math.radians(s.ground_max_tilt_deg))

    tol = _tolerance(pts)
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
        if not plausible(normal):
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
    if not plausible(normal):
        return None
    d = -normal @ centroid
    if not 0.2 < d < 8.0:  # широкие границы: масштаб глубины может быть ещё не откалиброван
        return None
    return GroundPlane(normal=normal, height=float(d))


def _fit_height(pts: np.ndarray, up: np.ndarray, rng: np.random.Generator) -> float | None:
    """Направление "вверх" известно (датчик телефона) — ищем только высоту камеры над полом.

    Для каждой точки -(p·up) — высота камеры над ней. Пол даёт самую большую группу
    одинаковых значений (1D-RANSAC); точки на препятствиях выше пола — меньшие значения.
    """
    n = len(pts)
    if n < 30:
        return None
    hs = -(pts @ up)
    tol = _tolerance(pts)
    best_h, best_count = None, 0
    for i in rng.choice(n, min(n, 60), replace=False):
        count = int((np.abs(hs - hs[i]) < tol).sum())
        if count > best_count:
            best_h, best_count = hs[i], count
    if best_h is None or best_count < 0.25 * n:
        return None
    h = float(np.median(hs[np.abs(hs - best_h) < tol]))
    return h if 0.2 < h < 8.0 else None  # широкие границы: масштаб глубины может быть ещё не откалиброван


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

    def _update_with_imu(self, up: np.ndarray, height: float | None) -> GroundPlane:
        # Наклон — всегда с датчика (мгновенно), высота — сглаженная; пол не виден — прежняя
        prev = self.plane
        if height is None:
            self.plane = GroundPlane(up, prev.height, prev.measured)
        elif not prev.measured:
            self.plane = GroundPlane(up, height)
        else:
            a = self.s.ground_smoothing
            self.plane = GroundPlane(up, (1 - a) * prev.height + a * height)
        return self.plane

    def analyze(
        self, depth_m: np.ndarray, detections: list[Detection], up: np.ndarray | None = None
    ) -> tuple[list[GenericObstacle], FreeSpaceDebug]:
        """up — направление "вверх" в координатах камеры с датчика телефона (если есть)."""
        s = self.s
        H, W = depth_m.shape
        step = max(1, max(W, H) // s.generic_grid_width)
        z = depth_m[step // 2::step, step // 2::step]
        gh, gw = z.shape
        us = (np.arange(gw) * step + step // 2).astype(np.float32)
        vs = (np.arange(gh) * step + step // 2).astype(np.float32)
        f = focal_px(W, H, s.camera_fov_deg)
        rx = np.broadcast_to((us[None, :] - W / 2) / f, (gh, gw))
        ry = np.broadcast_to((vs[:, None] - H / 2) / f, (gh, gw))
        pts = np.stack([rx * z, ry * z, z], axis=-1)  # (gh, gw, 3): X вправо, Y вниз, Z вперёд

        # Кандидаты в пол: лучи НИЖЕ горизонта (по текущей оценке "вверх"), не дальше 10 м.
        # Пока пол ни разу не видели и датчика нет — просто нижние 45% кадра.
        cand = (z > 0.2) & (z < 10)
        known_up = up if up is not None else (self.plane.normal if self.plane.measured else None)
        if known_up is not None:
            rays = np.stack([rx, ry, np.ones_like(rx)], axis=-1)
            below = (rays @ known_up) / np.linalg.norm(rays, axis=-1) < -0.1  # ниже горизонта на ~6°
            cand &= below
        else:
            cand[: int(gh * 0.55)] = False

        if up is not None:
            fit_h = _fit_height(pts[cand], up, self.rng)
            plane = self._update_with_imu(up, fit_h)
        else:
            expected = self.plane.normal if self.plane.measured else None
            fit = _fit_plane(pts[cand], s, self.rng, expected)
            fit_h = None if fit is None else fit.height
            plane = self._update_plane(fit)
        dbg = FreeSpaceDebug(plane=plane, imu=up is not None, fit_height=fit_h)

        h = plane.height_above(pts.reshape(-1, 3)).reshape(gh, gw)
        X, Zf = plane.to_ground(pts.reshape(-1, 3))
        X, Zf = X.reshape(gh, gw), Zf.reshape(gh, gw)
        dbg.ground = np.abs(h) < 0.08 + 0.03 * z
        dbg.ground_points = np.stack([X[dbg.ground], Zf[dbg.ground]], axis=1)
        obst = (h > s.generic_min_height_m) & (h < s.generic_max_height_m) & (Zf > 0.2) & (Zf < s.generic_max_range_m)

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
        for i in range(1, count):
            if stats[i, cv2.CC_STAT_AREA] < min_cells:
                continue
            cm = labels == i
            zc = Zf[cm]
            near_c = cm & (Zf <= np.percentile(zc, 30))
            rows_c, cols_c = np.nonzero(near_c)
            dbg.components.append((
                (int(cols_c.min() * step), int(rows_c.min() * step),
                 int(min(W, (cols_c.max() + 1) * step)), int(min(H, (rows_c.max() + 1) * step))),
                float(np.percentile(zc, 10)),
                float(np.median(X[near_c])),
            ))
        dbg.points = np.stack([X[keep], Zf[keep]], axis=1)
        if not keep.any():
            return [], dbg

        # Зоны в метрах по земле: коридор движения и полосы по бокам
        half = s.corridor_half_width_m
        zone_masks = {
            "center": keep & (np.abs(X) < half),
            "left": keep & (X <= -half) & (X > -s.generic_side_max_m),
            "right": keep & (X >= half) & (X < s.generic_side_max_m),
        }
        result: list[GenericObstacle] = []
        for zone in ZONES:
            zm = zone_masks[zone]
            # В узком коридоре вдали мало ячеек — порог площади для него мягче
            if zm.sum() < (min_cells / 4 if zone == "center" else min_cells / 2):
                continue
            zd = Zf[zm]
            dist = float(np.percentile(zd, 10))
            near = zm & (Zf <= np.percentile(zd, 30))  # ближняя часть — для рамки и смещения
            rows, cols = np.nonzero(near)
            box = (
                int(cols.min() * step),
                int(rows.min() * step),
                int(min(W, (cols.max() + 1) * step)),
                int(min(H, (rows.max() + 1) * step)),
            )
            xs = X[near]
            x_near = float(xs[np.argmin(np.abs(xs))])
            # Форма: вся связная область, к которой относится ближняя часть (не только полоса зоны),
            # на той же дистанции. Широкая и высокая — стена, узкая и высокая — столб/ствол.
            comp = np.isin(labels, np.unique(labels[near])) & keep & (Zf <= dist + 0.8)
            width = float(X[comp].max() - X[comp].min())
            top = float(h[comp].max())
            # Стена вдоль пути видна "с ребра": узкая по ширине, но длинная в глубину — это не столб
            full = np.isin(labels, np.unique(labels[near])) & keep
            depth_len = float(Zf[full].max() - Zf[full].min())
            if top < s.shape_low_top_m:
                shape = "low"
            elif top >= s.shape_tall_top_m and (width >= s.shape_wall_width_m or depth_len >= s.shape_wall_width_m):
                shape = "wall"
            elif width <= s.shape_pole_width_m and top >= s.shape_tall_top_m:
                shape = "pole"
            else:
                shape = "obstacle"
            result.append(GenericObstacle(zone, dist, x_near, box, float(zm.sum()) / (gh * gw), shape))
        return result, dbg
