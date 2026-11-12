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
from .schemas import Alert, TrackedObject, Urgency


def _key(o: TrackedObject) -> str:
    return f"{o.kind}:{o.detection.track_id}"


class ThreatAssessor:
    def __init__(self, s: Settings):
        self.s = s
        self.primary_key: str | None = None
        self.primary_since = 0.0
        self.own_speed: dict[str, float] = {}
        self.lateral_speed: dict[str, float] = {}
        self.moving_since: dict[str, tuple[float, float]] = {}  # (начало серии "едет", последний кадр)
        self.present_since: dict[str, tuple[float, float]] = {}  # (начало серии "виден", последний кадр)
        self.seen: dict[str, float] = {}

    def reset(self) -> None:
        self.primary_key = None
        self.present_since.clear()
        self.own_speed.clear()
        self.lateral_speed.clear()
        self.moving_since.clear()
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
                    # Поперёк: ходьба пользователя прямо почти не даёт боковой скорости
                    prev_x = self.lateral_speed.get(k, o.vx_mps)
                    self.lateral_speed[k] = prev_x + s.own_speed_smoothing * (o.vx_mps - prev_x)
                    self.seen[k] = t
                o.own_speed_mps = round(self.own_speed.get(k, 0.0), 2) if o.motion_valid else 0.0
                o.lateral_speed_mps = round(self.lateral_speed.get(k, 0.0), 2) if o.motion_valid else 0.0
            o.moving = o.kind != "obstacle" and (
                o.own_speed_mps > s.moving_speed_mps.get(o.kind, 1.5)
                # машина едет поперёк (перекрёсток, выезд с парковки) — тоже едет
                or (o.kind == "vehicle" and abs(o.lateral_speed_mps) > s.vehicle_lateral_moving_mps)
            )
            # Как долго объект подряд "едет": мелькание на 2-3 кадра вдали — шум глубины.
            # Пропуск одного-двух кадров (< 0.3 с) серию не обрывает.
            k = _key(o)
            since, last = self.moving_since.get(k, (t, -1e9))
            if o.moving:
                self.moving_since[k] = (since if t - last < 0.3 else t, t)
            moving_for = t - self.moving_since[k][0] if o.moving else 0.0

            ttc = None
            receding = o.motion_valid and o.approach_mps < -0.3  # удаляемся (например, отходишь назад)
            # "Едет на тебя" — только вблизи и устойчиво; дальше — просто "едет" (голосом, без тревоги)
            if o.moving and o.distance.smoothed_m <= s.danger_max_range_m and moving_for >= s.danger_confirm_s:
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
            # Сколько объект уже виден подряд. Мелькнувшее на секунду (надпись или тень на асфальте,
            # ошибка глубины) — не угроза. Исключение — то, что уже вплотную.
            since, last = self.present_since.get(k, (t, -1e9))
            self.present_since[k] = (since if t - last < s.presence_gap_s else t, t)
            present_for = t - self.present_since[k][0]
            need = s.confirm_obstacle_s if o.kind == "obstacle" else s.confirm_object_s
            confirmed = present_for >= need or d <= s.instant_range_m
            if not confirmed:
                ttc = None

            o.ttc_s = None if ttc is None else round(ttc, 1)
            o.threat = ttc is not None and ttc < s.primary_max_ttc_s
            o.urgency = _urgency(o.ttc_s if o.threat else None, s)
            o.alert = _alert(o, s, moving_for) if confirmed else ("info" if o.kind != "obstacle" else "none")

        for k in [k for k, (_, last) in self.present_since.items() if t - last > 3.0]:
            self.present_since.pop(k, None)
        for k in [k for k, seen in self.seen.items() if t - seen > 3.0]:
            self.own_speed.pop(k, None)
            self.lateral_speed.pop(k, None)
            self.moving_since.pop(k, None)
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


def _alert(o: TrackedObject, s: Settings, moving_for: float) -> Alert:
    """Класс опасности: что озвучивать, что показывать, что убрать в фон."""
    if o.threat:
        return "danger"
    if o.kind == "obstacle":
        return "none"  # статичное не на пути — фон
    d = o.distance.smoothed_m
    if o.kind == "vehicle":
        if o.moving and d <= s.vehicle_warn_range_m and moving_for >= s.moving_confirm_s:
            return "warn"  # едущая машина — голосом, даже далеко (если едет устойчиво)
    else:  # человек / животное
        # Сам идёт к тебе (собственная скорость, без твоей ходьбы) — или стоит на твоём пути
        coming = o.motion_valid and o.own_speed_mps > s.person_approach_mps
        if d <= s.person_warn_range_m and (coming or o.in_path):
            return "warn"
    if not o.in_path and d <= s.side_warn_range_m:
        return "warn"  # живое/транспорт сбоку рядом — хотя бы голосом
    if d <= s.dynamic_info_range_m or o.moving:
        return "info"
    return "none"


def _urgency(ttc: float | None, s: Settings) -> Urgency:
    if ttc is None:
        return "low"
    if ttc < s.ttc_high_s:
        return "high"
    if ttc < s.ttc_medium_s:
        return "medium"
    return "low"
