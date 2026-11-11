"""Пространственная разметка: зона, панорама звука, срочность."""
from .config import Settings
from .schemas import Urgency, Zone


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


def urgency(distance_m: float, s: Settings) -> Urgency:
    if distance_m < s.near_m:
        return "high"
    if distance_m < s.mid_m:
        return "medium"
    return "low"
