"""Положение объекта в кадре: зона по третям кадра и панорама (-1..1).
Срочность и зоны в метрах считаются в threat.py."""
from .schemas import Zone


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
