"""Обстановка вокруг: толпа людей, парковка, подсказки по кадру.

Вместо того чтобы озвучивать каждого человека в толпе или каждую стоящую машину,
сервер сообщает одну группу: "толпа слева и впереди", "парковка".
Флаг включается, если условие держится context_enter_s, и выключается, только
если пропало на context_exit_s — чтобы не мигал от кадра к кадру.
"""
import cv2
import numpy as np

from .config import Settings
from .schemas import Group, GroupType, Hint, TrackedObject, Zone

ZONE_ORDER: list[Zone] = ["left", "center", "right"]


def _where(o: TrackedObject) -> Zone:
    if o.in_path or abs(o.bearing_deg) < 8:
        return "center"
    return "left" if o.bearing_deg < 0 else "right"


class _Flag:
    """Включение/выключение с задержкой."""

    def __init__(self) -> None:
        self.on = False
        self.since: float | None = None  # когда условие начало выполняться / перестало

    def update(self, cond: bool, t: float, enter_s: float, exit_s: float) -> bool:
        if cond == self.on:
            self.since = None
        elif self.since is None:
            self.since = t
        elif t - self.since >= (enter_s if cond else exit_s):
            self.on = cond
            self.since = None
        return self.on


class SceneContext:
    def __init__(self, s: Settings):
        self.s = s
        self.flags: dict[GroupType, _Flag] = {"crowd": _Flag(), "parking": _Flag(), "cluster": _Flag()}
        self.last: dict[GroupType, Group] = {}
        self.dark = _Flag()
        self.blurry = _Flag()

    def reset(self) -> None:
        self.__init__(self.s)

    def cluster(self, items: list[tuple[float, float]], t: float) -> Group | None:
        """Массивная группа предметов (столы и стулья, заставленный угол): items — (x вбок, дистанция)
        всех препятствий и предметов в кадре. Одной фразой вместо перечисления."""
        s = self.s
        near = [(x, d) for x, d in items if d <= s.cluster_range_m]
        on = self.flags["cluster"].update(len(near) >= s.cluster_min_objects, t, s.context_enter_s, s.context_exit_s)
        if not on:
            self.last.pop("cluster", None)
            return None
        if near:
            zone = lambda x: "center" if abs(x) < 0.6 else "left" if x < 0 else "right"  # noqa: E731
            counts = {z: sum(zone(x) == z for x, _ in near) for z in ZONE_ORDER}
            zones = [z for z in ZONE_ORDER if counts[z] >= 2] or [max(counts, key=counts.get)]  # type: ignore[arg-type]
            self.last["cluster"] = Group(type="cluster", zones=zones, count=len(near),
                                         distance=round(min(d for _, d in near), 1))
        return self.last.get("cluster")

    def update(self, objects: list[TrackedObject], gray: np.ndarray, t: float) -> tuple[list[Group], list[Hint]]:
        s = self.s
        people = [o for o in objects if o.kind == "person" and o.distance.smoothed_m <= s.crowd_range_m]
        parked = [o for o in objects if o.kind == "vehicle" and not o.moving
                  and o.distance.smoothed_m <= s.parking_range_m]
        found = {
            "crowd": (people, len(people) >= s.crowd_min_people),
            "parking": (parked, len(parked) >= s.parking_min_vehicles),
        }
        groups: list[Group] = []
        for gtype, (members, cond) in found.items():
            on = self.flags[gtype].update(cond, t, s.context_enter_s, s.context_exit_s)  # type: ignore[index]
            if not on:
                self.last.pop(gtype, None)  # type: ignore[arg-type]
                continue
            if members:
                counts = {z: sum(_where(o) == z for o in members) for z in ZONE_ORDER}
                # Зоны, где заметная часть группы (хотя бы 2 объекта или четверть)
                need = max(1, min(2, len(members) // 4 + 1))
                zones = [z for z in ZONE_ORDER if counts[z] >= need] or [max(counts, key=counts.get)]  # type: ignore[arg-type]
                self.last[gtype] = Group(  # type: ignore[index]
                    type=gtype, zones=zones, count=len(members),  # type: ignore[arg-type]
                    distance=round(min(o.distance.smoothed_m for o in members), 1),
                )
            if gtype in self.last:  # группа на секунду пропала из кадра — держим последнюю
                groups.append(self.last[gtype])  # type: ignore[index]

        hints: list[Hint] = []
        # Яркость по уменьшенному кадру — почти бесплатно
        if self.dark.update(float(gray[::8, ::8].mean()) < s.dark_mean_gray, t, 1.0, 1.0):
            hints.append("too_dark")
        # Резкость (дисперсия лапласиана): размыто, запотело, закрыто пальцем, вплотную к
        # однотонной стене — по такому кадру ничего надёжно не определить.
        # Обычные кадры дают > 1500, сильно размытые < 150.
        elif self.blurry.update(float(cv2.Laplacian(gray[::2, ::2], cv2.CV_32F).var()) < s.blur_min_sharpness,
                                t, 1.5, 1.0):
            hints.append("blurry")
        return groups, hints
