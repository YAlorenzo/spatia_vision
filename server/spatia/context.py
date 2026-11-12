"""Обстановка вокруг: толпа людей, парковка, подсказки по кадру.

Вместо того чтобы озвучивать каждого человека в толпе или каждую стоящую машину,
сервер сообщает одну группу: "толпа слева и впереди", "парковка".
Флаг включается, если условие держится context_enter_s, и выключается, только
если пропало на context_exit_s — чтобы не мигал от кадра к кадру.
"""
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
        self.flags: dict[GroupType, _Flag] = {"crowd": _Flag(), "parking": _Flag()}
        self.last: dict[GroupType, Group] = {}
        self.dark = _Flag()

    def reset(self) -> None:
        self.__init__(self.s)

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
        return groups, hints
