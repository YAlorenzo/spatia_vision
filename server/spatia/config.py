"""Все настройки бэкенда в одном месте."""
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

SERVER_DIR = Path(__file__).resolve().parent.parent

# Реальная высота объектов (м). Нужна для геометрической оценки дистанции:
# distance = focal_px * real_height / bbox_height_px
KNOWN_HEIGHTS_M: dict[str, float] = {
    "person": 1.70,
    "car": 1.50,
    "bus": 3.00,
    "truck": 3.00,
    "bicycle": 1.05,
    "motorcycle": 1.10,
    "chair": 0.90,
    "bench": 0.85,
    "fire hydrant": 0.75,
    "stop sign": 2.10,
    "dog": 0.55,
    "horse": 1.60,
    "cow": 1.40,
    "train": 3.80,
}

# Детектор ищет только то, что может ДВИГАТЬСЯ — для них важно знать, кто это,
# и следить за скоростью. Всё статичное (деревья, столбы, стены, мебель)
# находится без классов по карте глубины (spatia/free_space.py).
DYNAMIC_CLASSES: dict[str, str] = {
    "person": "person",
    "bicycle": "vehicle",
    "motorcycle": "vehicle",
    "car": "vehicle",
    "bus": "vehicle",
    "truck": "vehicle",
    "train": "vehicle",
    "dog": "animal",
    "cat": "animal",
    "horse": "animal",
    "cow": "animal",
    "sheep": "animal",
}

# Класс, под которым уходят препятствия, найденные по глубине
GENERIC_CLASS = "obstacle"

Scene = Literal["outdoor", "indoor"]

DEPTH_MODELS: dict[str, str] = {
    "outdoor": "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf",  # улица, до 80 м
    "indoor": "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf",  # помещения, до 20 м
}


@dataclass
class Settings:
    device: str = "cuda"  # "cuda" | "cpu" (если CUDA недоступна — автоматически cpu)

    # --- Детекция ---
    # YOLO11s: на RTX 3050 Ti так же быстр, как 11n (~18 мс), но находит на 10-20% больше
    yolo_weights: Path = SERVER_DIR / "yolo11s.pt"
    # Детектор отдаёт всё от этого порога: слабые рамки трекер использует, чтобы не терять
    # уже известные объекты (люди в толпе закрывают друг друга)
    yolo_conf: float = 0.25
    # Новый объект появляется, только если хоть раз увиден с такой уверенностью
    confirm_conf: dict[str, float] = field(default_factory=lambda: {"person": 0.35})
    confirm_conf_default: float = 0.45
    yolo_imgsz: int = 640
    use_tracking: bool = True  # ByteTrack: стабильные ID объектов между кадрами
    max_frame_side: int = 960  # кадры с длинной стороной больше — ужимаем (защита от огромных фото)
    dynamic_classes: dict[str, str] = field(default_factory=lambda: dict(DYNAMIC_CLASSES))
    # "Человек", чья рамка начинается ниже этой доли высоты кадра и упирается в нижний край, —
    # рука/нога снимающего, отбрасываем
    hand_min_top: float = 0.5

    # --- Глубина ---
    depth_model_id: str = DEPTH_MODELS["outdoor"]
    depth_input_size: int = 518  # короткая сторона входа модели (кратно 14)

    # --- Дистанция ---
    depth_percentile: float = 30.0  # ближние 30% пикселей объекта — отсекает фон
    camera_fov_deg: float = 65.0  # угол обзора камеры по ДЛИННОЙ стороне кадра (телефон ~60-70°)
    use_geometry: bool = True
    geometry_weight: float = 0.5  # вес геометрии при слиянии с моделью глубины
    # Расхождение глубины и геометрии (во сколько раз): от 1.2x вес начинает
    # плавно смещаться к меньшей оценке, к 2x — полностью на неё
    disagreement_range: tuple[float, float] = (1.2, 2.0)
    auto_scale: bool = True  # калибровать масштаб глубины по людям/машинам в кадре
    auto_scale_alpha: float = 0.05
    auto_scale_limits: tuple[float, float] = (0.25, 4.0)
    known_heights: dict[str, float] = field(default_factory=lambda: dict(KNOWN_HEIGHTS_M))
    min_distance_m: float = 0.3
    max_distance_m: float = 30.0

    # --- Сглаживание во времени ---
    smoothing: bool = True
    smoothing_alpha: float = 0.35  # 0..1, меньше = плавнее, но медленнее реакция
    track_ttl_frames: int = 30  # сколько кадров помнить пропавший объект

    # --- Препятствия по глубине (без классов) ---
    generic_obstacles: bool = True
    generic_grid_width: int = 160  # карта глубины ужимается до этой ширины для анализа
    generic_max_range_m: float = 7.0  # дальше — не интересно для навигации
    generic_min_height_m: float = 0.25  # ниже — бордюр/неровность пола, не препятствие
    generic_max_height_m: float = 2.0  # выше — над головой, не мешает
    generic_min_area: float = 0.004  # минимальная доля кадра, чтобы не реагировать на шум
    generic_side_max_m: float = 2.0  # препятствия сбоку дальше этого (в сторону) не интересны
    # Оценка плоскости пола (RANSAC по нижней части кадра)
    ground_iterations: int = 80
    ground_max_tilt_deg: float = 55.0  # насколько камера может быть наклонена к полу
    ground_smoothing: float = 0.3  # EMA плоскости пола между кадрами
    # Пол не виден (вплотную к стене)? Держим последнюю найденную плоскость: телефон
    # в руке держится примерно одинаково. Если пол ещё ни разу не нашли — используем это:
    ground_prior_height_m: float = 1.35
    ground_prior_pitch_deg: float = 15.0

    # --- Коридор движения и главная опасность ---
    corridor_half_width_m: float = 0.45  # полоса "куда я иду": плечи + запас
    walk_speed_mps: float = 1.0  # для времени до столкновения, если стоишь (можешь пойти)
    cpa_margin_m: float = 0.6  # едущее пройдёт ближе коридора + этот запас — опасно
    path_max_range_m: float = 7.0  # неподвижное в коридоре дальше этого — ещё не опасность
    primary_max_ttc_s: float = 7.0  # дальше по времени — опасности нет
    primary_switch_ratio: float = 1.4  # новая угроза должна быть в 1.4 раза опаснее, чтобы сменить главную
    primary_hold_s: float = 1.0  # первую секунду после смены — только если вдвое опаснее

    # --- Классы опасности (поле alert) ---
    # Люди/животные/транспорт ближе этого — всегда видны (не серые)
    dynamic_info_range_m: float = 13.0
    # Голосом: человек/животное идёт к тебе или стоит у тебя на пути — ближе этого
    person_warn_range_m: float = 13.0
    person_approach_mps: float = 0.5  # сближение быстрее — "идёт к тебе"
    # Голосом: человек/животное/машина сбоку — ближе этого
    side_warn_range_m: float = 6.0
    # Едущая машина — голосом в пределах этой дистанции
    vehicle_warn_range_m: float = 20.0
    # Едет поперёк (боковая собственная скорость), м/с: машина не обязательно едет НА тебя
    vehicle_lateral_moving_mps: float = 3.0
    moving_confirm_s: float = 0.5  # "едет" должно держаться столько, чтобы сказать голосом
    # Тревога "едет НА тебя" (danger): только ближе этого и если "едет" держится столько
    danger_max_range_m: float = 15.0
    danger_confirm_s: float = 0.3
    # Объект должен быть виден подряд столько, чтобы стать угрозой (мелькание — надпись
    # на асфальте, тень, ошибка глубины — игнорируем). Ближе instant_range_m — сразу.
    confirm_obstacle_s: float = 1.5  # препятствие по глубине
    confirm_object_s: float = 0.5  # человек / машина / животное
    presence_gap_s: float = 0.4  # пропуск кадров короче — серия не обрывается
    instant_range_m: float = 1.0

    # --- Обстановка (толпа, парковка) ---
    crowd_range_m: float = 20.0
    crowd_min_people: int = 4  # столько людей рядом — толпа
    parking_range_m: float = 20.0
    parking_min_vehicles: int = 3  # столько стоящих машин рядом — парковка
    context_enter_s: float = 1.0  # условие держится столько — включаем флаг
    context_exit_s: float = 4.0  # условие пропало на столько — выключаем
    dark_mean_gray: float = 35.0  # средняя яркость кадра ниже — "слишком темно"
    blur_min_sharpness: float = 150.0  # резкость кадра ниже — "неразборчиво" (обычно > 1500)

    # --- Движение ---
    motion_window_s: float = 1.0  # окно для оценки скорости сближения
    motion_max_range_m: float = 20.0  # дальше скорость не оцениваем (шум глубины)
    motion_noise_frac: float = 0.15  # кажущаяся скорость от шума ~ 15% дистанции в секунду
    motion_jump_frac: float = 0.3  # скачок дистанции больше 30% за кадр — это другой объект, историю сбрасываем
    # СОБСТВЕННАЯ скорость объекта (за вычетом твоей) больше — движется сам.
    # Для машин порог выше: ложное "машина едет" пугает, а едущая машина даёт 5+ м/с
    moving_speed_mps: dict[str, float] = field(default_factory=lambda: {"vehicle": 2.5, "person": 1.5, "animal": 1.5})
    own_speed_smoothing: float = 0.3  # EMA собственной скорости объекта
    ego_smoothing: float = 0.2  # EMA скорости пользователя
    ttc_high_s: float = 3.0  # время до столкновения меньше — "high"
    ttc_medium_s: float = 6.0  # меньше — "medium"

    # --- Пространство ---
    near_m: float = 2.0  # ближе — "high"
    mid_m: float = 4.0  # ближе — "medium", дальше — "low"
