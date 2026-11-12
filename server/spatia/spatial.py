"""Пространственная разметка: зона, панорама звука, срочность."""
from .config import Settings
from .schemas import Urgency, Zone

_RANK: dict[Urgency, int] = {"low": 0, "medium": 1, "high": 2}


def zone_and_pan(box: tuple[int, int, int, int], frame_width: int) -> tuple[Zone, float]:
    cx = (box[0] + box[2]) / 2
    pan = max(-1.0, min(1.0, cx / frame_width * 2 - 1))  # непрерывная панорама
    if pan < -1 / 3:
        zone: Zone = "left"
    elif pan > 1 / 3:
        zone = "right"
    else:
        zone = "center"
    return zone, round(pan, 2)


def urgency(distance_m: float, ttc_s: float | None, s: Settings) -> Urgency:
    """Худшее из двух: по дистанции и по времени до столкновения."""
    by_dist: Urgency = "high" if distance_m < s.near_m else "medium" if distance_m < s.mid_m else "low"
    by_ttc: Urgency = "low"
    if ttc_s is not None:
        by_ttc = "high" if ttc_s < s.ttc_high_s else "medium" if ttc_s < s.ttc_medium_s else "low"
    return by_dist if _RANK[by_dist] >= _RANK[by_ttc] else by_ttc
