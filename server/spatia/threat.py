"""Главная опасность.

Пользователь идёт вперёд, поэтому важно не "всё вокруг", а:
  1. то, что В КОРИДОРЕ движения (во что врежешься, если идти прямо);
  2. то, что ЕДЕТ/ИДЁТ так, что пройдёт рядом с пользователем (точка наибольшего
     сближения ближе коридора + запас) — даже если сейчас сбоку.
Всё остальное (стоящие машины сбоку, стены вдоль тротуара) — не угроза.

Для каждой угрозы считается "эффективное время до столкновения":
  - в коридоре: дистанция / max(скорость сближения, скорость шага) — стена в 2 м
    опасна, даже если стоишь (можешь пойти);
  - движется сам: время до точки наибольшего сближения.
Главная угроза — с наименьшим временем; сменяется только если новая заметно опаснее
(гистерезис), чтобы звук не прыгал между объектами.
"""
import math

from .config import Settings
from .schemas import TrackedObject, Urgency


def _key(o: TrackedObject) -> str:
    return f"{o.kind}:{o.detection.track_id}"


class ThreatAssessor:
    def __init__(self, s: Settings):
        self.s = s
        self.primary_key: str | None = None
        self.primary_since = 0.0
        self.own_speed: dict[str, float] = {}
        self.seen: dict[str, float] = {}

    def reset(self) -> None:
        self.primary_key = None
        self.own_speed.clear()
        self.seen.clear()

    def assess(self, objects: list[TrackedObject], ego_speed: float, focal: float, t: float) -> TrackedObject | None:
        s = self.s
        for o in objects:
            d = o.distance.smoothed_m
            b = math.radians(o.bearing_deg)
            if o.kind == "obstacle":
                # Для препятствий по глубине всё уже в метрах: дистанция = вперёд по оси камеры
                o.forward_m = d
                o.in_path = o.zone == "center"
                o.own_speed_mps = 0.0
            else:
                o.forward_m = d * math.cos(b)
                x1, _, x2, _ = o.detection.box
                half_w = (x2 - x1) / 2 * o.forward_m / focal
                o.lateral_m = abs(d * math.sin(b))
                o.in_path = o.lateral_m - half_w < s.corridor_half_width_m
                o.zone = "center" if o.in_path else "left" if o.bearing_deg < 0 else "right"
                # Собственная скорость = относительная - вклад движения пользователя вдоль луча,
                # сглаженная по объекту: одиночные выбросы не должны давать "едет"
                k = _key(o)
                if o.motion_valid:
                    raw = o.approach_mps - ego_speed * math.cos(b)
                    prev = self.own_speed.get(k, raw)
                    self.own_speed[k] = prev + s.own_speed_smoothing * (raw - prev)
                    self.seen[k] = t
                o.own_speed_mps = round(self.own_speed.get(k, 0.0), 2) if o.motion_valid else 0.0
            o.moving = o.kind != "obstacle" and o.own_speed_mps > s.moving_speed_mps.get(o.kind, 1.5)

            ttc = None
            receding = o.motion_valid and o.approach_mps < -0.3  # удаляемся (например, отходишь назад)
            if o.moving:
                # Едет/идёт: опасно, только если траектория пройдёт рядом с пользователем.
                # Точка наибольшего сближения (CPA) по относительной скорости на земле.
                x, z = math.copysign(o.lateral_m, o.bearing_deg), o.forward_m
                vx, vz = o.vx_mps, o.vz_mps
                v2 = vx * vx + vz * vz
                if v2 > 0.25:
                    t_cpa = -(x * vx + z * vz) / v2
                    cpa = math.hypot(x + vx * t_cpa, z + vz * t_cpa)
                    x1, _, x2, _ = o.detection.box
                    half_w = (x2 - x1) / 2 * o.forward_m / focal
                    if 0 < t_cpa < s.primary_max_ttc_s and cpa < half_w + s.corridor_half_width_m + s.cpa_margin_m:
                        ttc = t_cpa
            if ttc is None and o.in_path and not receding and not o.moving and o.forward_m <= s.path_max_range_m:
                # Неподвижное в коридоре. Стоишь — всё равно предупреждаем (можешь пойти),
                # идёшь — по реальной скорости. Для едущего решает только CPA выше.
                ttc = o.forward_m / max(o.approach_mps, s.walk_speed_mps)
            o.ttc_s = None if ttc is None else round(ttc, 1)
            o.threat = ttc is not None and ttc < s.primary_max_ttc_s
            o.urgency = _urgency(o.ttc_s if o.threat else None, s)

        for k in [k for k, seen in self.seen.items() if t - seen > 3.0]:
            self.own_speed.pop(k, None)
            self.seen.pop(k, None)

        threats = [o for o in objects if o.threat]
        best = min(threats, key=lambda o: o.ttc_s, default=None)  # type: ignore[arg-type, return-value]
        if best is not None and self.primary_key is not None:
            prev = next((o for o in threats if _key(o) == self.primary_key), None)
            if prev is not None:
                # Только что сменили главную — держим её, пока новая не станет вдвое опаснее
                ratio = 2.0 if t - self.primary_since < s.primary_hold_s else s.primary_switch_ratio
                if prev.ttc_s <= best.ttc_s * ratio:  # type: ignore[operator]
                    best = prev
        key = None if best is None else _key(best)
        if key != self.primary_key:
            self.primary_since = t
        self.primary_key = key
        if best is not None:
            best.primary = True
        return best


def _urgency(ttc: float | None, s: Settings) -> Urgency:
    if ttc is None:
        return "low"
    if ttc < s.ttc_high_s:
        return "high"
    if ttc < s.ttc_medium_s:
        return "medium"
    return "low"
