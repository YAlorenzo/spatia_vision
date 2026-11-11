from ..config import Settings
from .base import DepthEstimator


def create_depth_estimator(settings: Settings, device: str) -> DepthEstimator:
    if settings.depth_backend == "depth_anything":
        from .depth_anything import DepthAnythingMetric

        return DepthAnythingMetric(settings.depth_model_id, device, settings.depth_input_size)
    if settings.depth_backend == "midas":
        from .midas import MidasSmall

        return MidasSmall(device, settings.midas_scale)
    raise ValueError(f"Неизвестный depth_backend: {settings.depth_backend}")


__all__ = ["DepthEstimator", "create_depth_estimator"]
