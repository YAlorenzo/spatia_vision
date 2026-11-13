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
    # Название по форме (когда детектор не знает, что это)
    shape_low_top_m: float = 0.9  # ниже — "низкое препятствие" (бордюр, тумба, ящик)
    shape_tall_top_m: float = 1.3  # выше — "высокое"
    shape_wall_width_m: float = 1.8  # высокое и шире — "стена"
    shape_pole_width_m: float = 0.5  # высокое и уже — "столб или дерево"
    # Подтверждённое препятствие на пути мигнуло (пропало на пару кадров) — держим его столько
    obstacle_hold_s: float = 0.6
    # Неподвижные предметы, которые детектор знает по имени: ими подписываются препятствия по глубине
    static_classes: tuple[str, ...] = (
        "bench", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "refrigerator",
        "fire hydrant", "stop sign", "parking meter", "suitcase", "sink", "tv",
    )
    static_conf: float = 0.4

    # --- Советы обхода (свободные направления) ---
    # Полосы — параллельные проходы, сдвинутые вбок (шаг в сторону и дальше прямо)
    bypass_step_m: float = 0.15
    bypass_min_shift_m: float = 0.6  # меньше — это не обход, а тот же путь
    bypass_max_shift_m: float = 1.8
    bypass_half_width_m: float = 0.35  # полуширина прохода (человек боком к препятствию)
    bypass_before_m: float = 0.5  # полоса проверяется от стольких метров до препятствия...
    bypass_beyond_m: float = 1.0  # ...до стольких за ним
    bypass_min_ground_cells: int = 6  # столько ячеек пола должно быть видно в полосе
    bypass_keep_side_m: float = 0.6  # прежняя сторона обхода держится, пока она не дальше лучшей на столько
    # Оценка плоскости пола (RANSAC по нижней части кадра)
    ground_iterations: int = 80
    # Без датчика телефона и до первой оценки пола: насколько камера может быть наклонена к полу
    ground_max_tilt_deg: float = 75.0
    # Новая плоскость пола не может отличаться от прошлой больше чем на столько (иначе это стена)
    ground_max_change_deg: float = 30.0
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
    confirm_obstacle_s: float = 1.5  # препятствие по глубине — не дольше этого
    confirm_object_s: float = 0.5  # человек / машина / животное — не дольше этого
    confirm_ttc_frac: float = 0.25  # на проверку — не больше четверти времени до столкновения
    confirm_min_s: float = 0.2  # и не меньше этого (2-3 кадра)
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
    # Скачок дистанции больше 15% за кадр — это другой объект / перекрытие, историю сбрасываем.
    # (идущий человек в 5 м меняет дистанцию за кадр ~на 4%)
    motion_jump_frac: float = 0.15
    # СОБСТВЕННАЯ скорость объекта (за вычетом твоей) больше — "быстро движется" (тревога).
    # Обычный пешеход навстречу (~1.3 м/с) — не тревога, а спокойное "идёт к вам";
    # 2.5 м/с — бег, самокат. Едущая машина даёт 5+ м/с.
    moving_speed_mps: dict[str, float] = field(default_factory=lambda: {"vehicle": 2.5, "person": 2.5, "animal": 2.5})
    own_speed_smoothing: float = 0.3  # EMA собственной скорости объекта
    # Для людей/животных: считаем, что пользователь идёт не медленнее этого (оценка по картинке
    # бывает занижена — тогда пешеход навстречу выглядел бы бегущим)
    assumed_walk_mps: float = 1.2
    ego_smoothing: float = 0.2  # EMA скорости пользователя
    ttc_high_s: float = 3.0  # время до столкновения меньше — "high"
    ttc_medium_s: float = 6.0  # меньше — "medium"

    # --- Пространство ---
    near_m: float = 2.0  # ближе — "high"
    mid_m: float = 4.0  # ближе — "medium", дальше — "low"
