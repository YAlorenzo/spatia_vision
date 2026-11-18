"""Карта местности (вид сверху) и маршрут по курсу в обход препятствий.

Камера телефона видит узко (~40°), поэтому решать "куда обойти" по одному кадру ненадёжно.
Карта помнит всё, что камера видела раньше:

  - Сетка в земных координатах (клетка 10 см). Каждый кадр точки препятствий (всё, что выше пола)
    добавляют клетке "занятость", видимый пол — убирает: убрали стул, камера увидела пол — клетка
    очистилась. Без подтверждения занятость медленно гаснет (полураспад ~60 с).
  - Где человек: курс камеры — компас телефона (присылает клиент), сдвиг — скорость ходьбы, которую
    сервер оценивает по полу (EgoMotion). Это счисление пути: за минуту-две накапливается ошибка,
    поэтому карта "живёт" недолго.
  - Люди, машины, животные на карту не пишутся (они двигаются) — но мешают маршруту, пока видны.

Маршрут: A* по карте 15 x 15 м вокруг человека, полоса шириной 0.5 м (препятствия раздуваются на
полширины + запас), от человека к точке в 6.5 м по курсу. Если путь прямо по курсу перекрыт —
маршрут огибает препятствие; из него и берётся сторона обхода.
"""
import heapq
import math

import cv2
import numpy as np

from .config import Settings


class WorldMap:
    def __init__(self, s: Settings):
        self.s = s
        self.res = s.map_cell_m
        self.n = int(round(s.map_extent_m / self.res))  # сторона всей сетки в клетках
        self.reset()

    def reset(self) -> None:
        self.grid = np.zeros((self.n, self.n), np.float32)  # "занятость": > порога — препятствие
        self.pos = np.zeros(2)  # где человек, м (мир)
        self.origin = self.pos - self.s.map_extent_m / 2  # мировые координаты угла сетки
        self.t: float | None = None
        self.heading: float | None = None
        self.path: list[tuple[float, float]] | None = None  # маршрут в мировых координатах
        self.path_t = -1e9
        self.dynamic: np.ndarray = np.zeros((0, 2))  # люди/машины текущего кадра (мир)

    # --- оси: курс камеры по компасу (по часовой, ноль произвольный) -> мир (x — "восток", y — "север")
    @staticmethod
    def axes(heading_deg: float) -> tuple[np.ndarray, np.ndarray]:
        th = math.radians(heading_deg)
        fwd = np.array([math.sin(th), math.cos(th)])
        right = np.array([math.cos(th), -math.sin(th)])
        return right, fwd

    def to_world(self, xz: np.ndarray, heading_deg: float) -> np.ndarray:
        """(N, 2) X вправо / Z вперёд от человека -> мировые координаты."""
        right, fwd = self.axes(heading_deg)
        return self.pos + xz[:, :1] * right + xz[:, 1:2] * fwd

    def to_user(self, w: np.ndarray, heading_deg: float) -> np.ndarray:
        """Мировые -> (X вправо, Z вперёд) относительно человека и камеры."""
        right, fwd = self.axes(heading_deg)
        d = w - self.pos
        return np.stack([d @ right, d @ fwd], axis=1)

    def _cells(self, w: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        ij = np.floor((w - self.origin) / self.res).astype(int)
        ok = (ij[:, 0] >= 0) & (ij[:, 0] < self.n) & (ij[:, 1] >= 0) & (ij[:, 1] < self.n)
        return ij[ok, 0], ij[ok, 1], ok

    def _recenter(self) -> None:
        """Человек ушёл к краю сетки — сдвигаем сетку, чтобы он снова был в центре."""
        c = (self.pos - self.origin) / self.res
        margin = self.n * 0.25
        if margin < c[0] < self.n - margin and margin < c[1] < self.n - margin:
            return
        shift = np.round(c - self.n / 2).astype(int)
        g = np.zeros_like(self.grid)
        sx, sy = shift
        src = self.grid[max(0, sy):self.n + min(0, sy), max(0, sx):self.n + min(0, sx)]
        g[max(0, -sy):max(0, -sy) + src.shape[0], max(0, -sx):max(0, -sx) + src.shape[1]] = src
        self.grid = g
        self.origin = self.origin + shift * self.res

    def update(self, t: float, heading_deg: float | None, ego_mps: float,
               obstacles_xz: np.ndarray | None, ground_xz: np.ndarray | None, dynamic_xz: np.ndarray) -> None:
        s = self.s
        if heading_deg is None:
            heading_deg = self.heading if self.heading is not None else 0.0
        dt = 0.0 if self.t is None else min(max(t - self.t, 0.0), 0.5)
        self.t, self.heading = t, heading_deg
        _, fwd = self.axes(heading_deg)
        self.pos = self.pos + ego_mps * dt * fwd  # счисление пути
        self._recenter()
        if dt > 0:
            self.grid *= 0.5 ** (dt / s.map_half_life_s)

        def near(xz: np.ndarray | None) -> np.ndarray:
            if xz is None or not len(xz):
                return np.zeros((0, 2))
            return xz[(xz[:, 1] > 0.2) & (xz[:, 1] < s.map_max_range_m)]

        g = near(ground_xz)
        if len(g):
            ix, iy, _ = self._cells(self.to_world(g, heading_deg))
            np.add.at(self.grid, (iy, ix), -s.map_free_step)
        o = near(obstacles_xz)
        if len(o):
            ix, iy, _ = self._cells(self.to_world(o, heading_deg))
            np.add.at(self.grid, (iy, ix), s.map_occ_step)
        np.clip(self.grid, -2.0, 6.0, out=self.grid)
        self.dynamic = self.to_world(dynamic_xz, heading_deg) if len(dynamic_xz) else np.zeros((0, 2))

    # --- окно вокруг человека
    def _window(self, res: float) -> tuple[np.ndarray, np.ndarray]:
        """Занятость в окне 15 x 15 м вокруг человека с шагом res: (bool-сетка, мировые координаты её угла)."""
        half = self.s.map_view_m / 2
        k = max(1, int(round(res / self.res)))
        c = np.floor((self.pos - self.origin) / self.res).astype(int)
        hw = int(round(half / self.res))
        x0, y0 = c[0] - hw, c[1] - hw
        size = 2 * hw
        occ = np.zeros((size, size), bool)
        sx0, sy0 = max(0, x0), max(0, y0)
        sx1, sy1 = min(self.n, x0 + size), min(self.n, y0 + size)
        if sx1 > sx0 and sy1 > sy0:
            occ[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = self.grid[sy0:sy1, sx0:sx1] >= self.s.map_occ_threshold
        m = size // k
        occ = occ[: m * k, : m * k].reshape(m, k, m, k).any(axis=(1, 3))
        corner = self.origin + np.array([x0, y0]) * self.res
        return occ, corner

    def plan(self, t: float, course_world_deg: float | None) -> list[tuple[float, float]] | None:
        """Маршрут по курсу в обход препятствий (мировые координаты) или None — курса нет / пути нет."""
        s = self.s
        if course_world_deg is None:
            self.path = None
            return None
        if t - self.path_t < s.plan_interval_s and self.path is not None:
            return self.path
        self.path_t = t
        res = s.plan_cell_m
        occ, corner = self._window(res)
        m = occ.shape[0]
        # люди / машины сейчас — тоже препятствие для маршрута
        if len(self.dynamic):
            ij = np.floor((self.dynamic - corner) / res).astype(int)
            ok = (ij >= 0).all(axis=1) & (ij < m).all(axis=1)
            occ[ij[ok, 1], ij[ok, 0]] = True
        # полоса 0.5 м: раздуваем препятствия на полширины + запас
        r = int(math.ceil((s.path_width_m / 2 + s.path_margin_m) / res))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        blocked = cv2.dilate(occ.astype(np.uint8), kernel) > 0
        start = tuple(np.floor((self.pos - corner) / res).astype(int))  # (x, y)
        sr = int(math.ceil(s.path_start_clear_m / res))  # сам человек и вокруг него — не препятствие
        yy, xx = np.ogrid[:m, :m]
        blocked[(xx - start[0]) ** 2 + (yy - start[1]) ** 2 <= sr * sr] = False

        # цель: точка по курсу; перекрыта — ближайшая свободная назад по лучу
        cr = math.radians(course_world_deg)
        direction = np.array([math.sin(cr), math.cos(cr)])
        goal = None
        for dist in np.arange(s.plan_goal_m, 1.0, -res):
            g = np.floor((self.pos + direction * dist - corner) / res).astype(int)
            if 0 <= g[0] < m and 0 <= g[1] < m and not blocked[g[1], g[0]]:
                goal = (int(g[0]), int(g[1]))
                break
        if goal is None:
            self.path = None
            return None
        cells = _astar(blocked, start, goal)
        if cells is None:
            self.path = None
            return None
        pts = [tuple(corner + (np.array(c) + 0.5) * res) for c in cells[:: max(1, int(0.4 / res))]]
        pts[0] = (float(self.pos[0]), float(self.pos[1]))
        if pts[-1] != tuple(corner + (np.array(cells[-1]) + 0.5) * res):
            pts.append(tuple(corner + (np.array(cells[-1]) + 0.5) * res))
        self.path = [(float(x), float(y)) for x, y in pts]
        return self.path

    def known(self, x_m: float, z_m: float, heading_deg: float | None) -> bool:
        """На карте уже есть препятствие в этой точке (X вправо, Z вперёд от человека), с точностью ~0.3 м.
        Нужно, чтобы препятствие, которое видели сбоку, сразу стало угрозой, когда к нему повернулся."""
        if heading_deg is None:
            return False
        w = self.to_world(np.array([[x_m, z_m]]), heading_deg)[0]
        c = np.floor((w - self.origin) / self.res).astype(int)
        r = int(round(0.3 / self.res))
        x0, x1 = max(0, c[0] - r), min(self.n, c[0] + r + 1)
        y0, y1 = max(0, c[1] - r), min(self.n, c[1] + r + 1)
        if x1 <= x0 or y1 <= y0:
            return False
        return bool((self.grid[y0:y1, x0:x1] >= self.s.map_occ_threshold).any())

    def near_sides(self, heading_deg: float | None) -> dict:
        """Ближайшее препятствие слева и справа рядом с человеком — по карте, в том числе то, что уже
        вышло из кадра (проходишь мимо стула — он сбоку, камера его не видит). Расстояние в метрах
        или None. Для тихого сигнала в соответствующее ухо при обходе."""
        out: dict[str, float | None] = {"left": None, "right": None}
        if heading_deg is None:
            return out
        s = self.s
        occ, corner = self._window(self.res)
        ys, xs = np.nonzero(occ)
        if not len(xs):
            return out
        w = corner + (np.stack([xs, ys], axis=1) + 0.5) * self.res
        u = self.to_user(w, heading_deg)
        box = ((np.abs(u[:, 0]) >= s.side_min_m) & (np.abs(u[:, 0]) <= s.side_max_m)
               & (u[:, 1] >= -s.side_behind_m) & (u[:, 1] <= s.side_ahead_m))
        for side, sel in (("left", box & (u[:, 0] < 0)), ("right", box & (u[:, 0] > 0))):
            if sel.any():
                out[side] = round(float(np.min(np.hypot(u[sel, 0], np.maximum(u[sel, 1], 0)))), 2)
        return out

    def side_at(self, heading_deg: float | None, forward_m: float) -> str | None:
        """С какой стороны маршрут проходит препятствие на расстоянии forward_m впереди:
        "left" / "right" — смещение маршрута там, где препятствие; None — маршрута нет или он прямой."""
        if self.path is None or heading_deg is None or len(self.path) < 2:
            return None
        u = self.to_user(np.array(self.path), heading_deg)
        near = u[(u[:, 1] > forward_m - 0.6) & (u[:, 1] < forward_m + 0.8)]
        if not len(near):
            return None
        x = near[np.argmax(np.abs(near[:, 0])), 0]
        if abs(x) < self.s.path_side_min_m:
            return None
        return "right" if x > 0 else "left"

    def path_bearing(self, heading_deg: float | None, ahead_m: float) -> float | None:
        """Куда ведёт маршрут на расстоянии ahead_m по нему: угол от оси камеры (> 0 — правее)."""
        if self.path is None or heading_deg is None or len(self.path) < 2:
            return None
        p = np.array(self.path)
        seg = np.linalg.norm(np.diff(p, axis=0), axis=1)
        acc = np.concatenate([[0], np.cumsum(seg)])
        i = int(np.searchsorted(acc, ahead_m))
        target = p[min(i, len(p) - 1)]
        u = self.to_user(target[None], heading_deg)[0]
        return math.degrees(math.atan2(u[0], max(u[1], 0.05)))

    def view(self, heading_deg: float | None, course_world_deg: float | None,
             seen: list[tuple[str, str, float, float]] | None = None) -> dict:
        """Для экрана "карта": занятые клетки, маршрут, люди и то, что видно сейчас (с названиями), —
        относительно человека, оси мира. seen — (вид, класс, X вправо, Z вперёд) объектов этого кадра."""
        res = self.s.map_view_cell_m
        occ, corner = self._window(res)
        ys, xs = np.nonzero(occ)
        cx = (corner[0] - self.pos[0]) / res
        cy = (corner[1] - self.pos[1]) / res
        flat = np.stack([np.round(xs + cx + 0.5), np.round(ys + cy + 0.5)], axis=1).astype(int).ravel().tolist()
        rel = lambda w: [round(float(w[0] - self.pos[0]), 2), round(float(w[1] - self.pos[1]), 2)]  # noqa: E731
        return {
            "cell": res,
            "occ": flat,
            "path": [rel(p) for p in self.path] if self.path else None,
            "people": [rel(p) for p in self.dynamic[:20]],
            "seen": [
                {"kind": kind, "cls": cls, **dict(zip(("x", "y"), rel(w)))}
                for (kind, cls, _, _), w in zip(seen or [], self.to_world(np.array([[x, z] for _, _, x, z in seen]), heading_deg)
                                                if seen and heading_deg is not None else [])
            ][:30],
            "heading": None if heading_deg is None else round(heading_deg, 1),
            "course": None if course_world_deg is None else round(course_world_deg % 360, 1),
        }


def _astar(blocked: np.ndarray, start: tuple[int, int], goal: tuple[int, int],
           max_expand: int = 1500) -> list[tuple[int, int]] | None:
    """A* по 8 соседям. blocked[y, x]. Возвращает клетки (x, y) от start до goal."""
    h, w = blocked.shape
    if not (0 <= start[0] < w and 0 <= start[1] < h):
        return None
    gx, gy = goal
    dist = np.full((h, w), np.inf, np.float32)
    came = np.full((h, w, 2), -1, np.int32)
    dist[start[1], start[0]] = 0.0
    heap = [(math.hypot(gx - start[0], gy - start[1]), 0.0, start)]
    budget = max_expand  # тупик: не перебирать всю карту (это десятки мс) — пути нет
    steps = [(1, 0, 1.0), (-1, 0, 1.0), (0, 1, 1.0), (0, -1, 1.0),
             (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)]
    while heap:
        _, d, (x, y) = heapq.heappop(heap)
        if (x, y) == goal:
            path = [(x, y)]
            while (x, y) != start:
                x, y = (int(v) for v in came[y, x])
                path.append((x, y))
            return path[::-1]
        if d > dist[y, x]:
            continue
        budget -= 1
        if budget < 0:
            return None
        for dx, dy, c in steps:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not blocked[ny, nx]:
                nd = d + c
                if nd < dist[ny, nx]:
                    dist[ny, nx] = nd
                    came[ny, nx] = (x, y)
                    heapq.heappush(heap, (nd + math.hypot(gx - nx, gy - ny), nd, (nx, ny)))
    return None
