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
    "refrigerator": 1.75,
    "dining table": 0.75,
    "parking meter": 1.30,
}

# Классы COCO, во что человек может врезаться / что важно озвучить.
# Мелочь (чашки, телефоны, еда) и то, что не встречается на пути, исключены.
OBSTACLE_CLASSES: frozenset[str] = frozenset({
    # люди и транспорт
    "person", "bicycle", "car", "motorcycle", "bus", "train", "truck",
    "skateboard",
    # уличная инфраструктура
    "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    # животные
    "dog", "cat", "horse", "sheep", "cow", "bird",
    # вещи на полу / в руках у людей рядом
    "backpack", "umbrella", "handbag", "suitcase",
    # мебель и крупная техника
    "chair", "couch", "potted plant", "bed", "dining table", "toilet",
    "tv", "sink", "refrigerator", "oven", "microwave", "vase",
})

DepthBackend = Literal["depth_anything", "midas"]
Sampling = Literal["robust", "center"]


@dataclass
class Settings:
    device: str = "cuda"  # "cuda" | "cpu" (если CUDA недоступна — автоматически cpu)

    # --- Детекция ---
    yolo_weights: Path = SERVER_DIR / "yolo11n.pt"
    yolo_conf: float = 0.45
    yolo_imgsz: int = 640
    use_tracking: bool = True  # ByteTrack: стабильные ID объектов между кадрами
    obstacle_classes: frozenset[str] = OBSTACLE_CLASSES

    # --- Глубина ---
    depth_backend: DepthBackend = "depth_anything"
    # Outdoor — улица (до 80 м), Indoor — помещения (до 20 м)
    depth_model_id: str = "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf"
    depth_input_size: int = 518  # короткая сторона входа модели (кратно 14)
    midas_scale: float = 1500.0  # только для legacy MiDaS

    # --- Дистанция ---
    sampling: Sampling = "robust"  # "center" = старый способ (точка в центре рамки)
    depth_percentile: float = 30.0  # ближние 30% пикселей объекта — отсекает фон
    camera_hfov_deg: float = 65.0  # горизонтальный угол обзора камеры (телефон ~60-70°)
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

    # --- Пространство ---
    near_m: float = 2.0  # ближе — "high"
    mid_m: float = 4.0  # ближе — "medium", дальше — "low"

    @classmethod
    def baseline(cls) -> "Settings":
        """Воспроизводит старый алгоритм (MiDaS + точка в центре) для сравнения."""
        return cls(
            depth_backend="midas",
            sampling="center",
            use_geometry=False,
            auto_scale=False,
            smoothing=False,
            use_tracking=True,  # только для ID в отчёте, на дистанцию не влияет
            yolo_conf=0.5,
            min_distance_m=0.5,
            max_distance_m=1e9,
        )
