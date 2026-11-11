from typing import Protocol

import numpy as np


class DepthEstimator(Protocol):
    name: str

    def estimate(self, frame_bgr: np.ndarray) -> np.ndarray:
        """Возвращает карту дистанций в метрах (float32, H x W, как у кадра)."""
        ...
