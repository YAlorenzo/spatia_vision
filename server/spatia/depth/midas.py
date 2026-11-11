"""Legacy: MiDaS small. Оставлен только для сравнения с новым подходом.

MiDaS выдаёт относительную обратную глубину (масштаб плавает от кадра к кадру),
поэтому "метры" здесь — это scale / value, как было в исходном vision.py.
"""
import cv2
import numpy as np
import torch


class MidasSmall:
    def __init__(self, device: str, scale: float = 1500.0):
        self.name = "MiDaS_small (legacy)"
        self.device = torch.device(device)
        self.half = self.device.type == "cuda"
        self.scale = scale

        self.model = torch.hub.load("intel-isl/MiDaS", "MiDaS_small").to(self.device).eval()
        if self.half:
            self.model.half()
        self.transform = torch.hub.load("intel-isl/MiDaS", "transforms").small_transform

    @torch.inference_mode()
    def estimate(self, frame_bgr: np.ndarray) -> np.ndarray:
        rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        x = self.transform(rgb).to(self.device)
        if self.half:
            x = x.half()
        pred = self.model(x)
        pred = torch.nn.functional.interpolate(
            pred.unsqueeze(1).float(), size=rgb.shape[:2], mode="bicubic", align_corners=False
        ).squeeze()
        inv_depth = pred.cpu().numpy().astype(np.float32)
        return self.scale / (inv_depth + 1e-6)
