"""Depth Anything V2 Metric (Small) — монокулярная глубина сразу в метрах.

Лицензия Small-чекпойнтов: Apache-2.0 (Base/Large — CC-BY-NC, не используем).
"""
import cv2
import numpy as np
import torch
import torch.nn.functional as F
from transformers import AutoModelForDepthEstimation

_MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
_STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
_PATCH = 14  # ViT patch size — стороны входа должны быть кратны 14


class DepthAnythingMetric:
    def __init__(self, model_id: str, device: str, input_size: int = 518):
        self.name = model_id.split("/")[-1]
        self.device = torch.device(device)
        self.half = self.device.type == "cuda"
        self.input_size = input_size

        model = AutoModelForDepthEstimation.from_pretrained(model_id).to(self.device).eval()
        self.model = model.half() if self.half else model
        dtype = torch.float16 if self.half else torch.float32
        self.mean = _MEAN.to(self.device, dtype)
        self.std = _STD.to(self.device, dtype)

    def _input_hw(self, h: int, w: int) -> tuple[int, int]:
        scale = self.input_size / min(h, w)
        return (
            max(_PATCH, round(h * scale / _PATCH) * _PATCH),
            max(_PATCH, round(w * scale / _PATCH) * _PATCH),
        )

    @torch.inference_mode()
    def estimate(self, frame_bgr: np.ndarray) -> np.ndarray:
        h, w = frame_bgr.shape[:2]
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        # Предобработка целиком на GPU — быстрее, чем HF image processor на CPU
        x = torch.from_numpy(rgb).to(self.device).permute(2, 0, 1).unsqueeze(0)
        x = x.half() if self.half else x.float()
        x = F.interpolate(x / 255.0, size=self._input_hw(h, w), mode="bicubic", align_corners=False)
        x = (x.clamp(0, 1) - self.mean) / self.std

        depth = self.model(pixel_values=x).predicted_depth  # (1, h', w'), метры
        depth = F.interpolate(depth.unsqueeze(1).float(), size=(h, w), mode="bilinear", align_corners=False)
        return depth[0, 0].cpu().numpy().astype(np.float32)
