import cv2
import torch
import numpy as np
from ultralytics import YOLO

class VisionEngine:
    def __init__(self):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"👀 Инициализация нейросетей на {self.device.type.upper()}...")
        
        self.yolo = YOLO("yolo11n.pt")
        self.yolo.to(self.device)
        
        self.midas = torch.hub.load("intel-isl/MiDaS", "MiDaS_small")
        self.midas.to(self.device)
        self.midas.eval()
        
        if self.device.type == "cuda":
            self.midas.half()
            
        self.transform = torch.hub.load("intel-isl/MiDaS", "transforms").small_transform
        self.depth_scale = 1500  # Твоя калибровка

    def process_frame(self, frame):
        img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        height, width, _ = frame.shape
        
        # 1. Глубина (MiDaS)
        input_batch = self.transform(img_rgb).to(self.device)
        if self.device.type == "cuda":
            input_batch = input_batch.half()
            
        with torch.no_grad():
            prediction = self.midas(input_batch)
            prediction = torch.nn.functional.interpolate(
                prediction.unsqueeze(1), size=img_rgb.shape[:2], 
                mode="bicubic", align_corners=False
            ).squeeze()
        depth_map = prediction.cpu().numpy()
        
        # 2. Объекты (YOLO)
        results = self.yolo.predict(frame, verbose=False)
        
        objects_data = []
        for result in results:
            for box in result.boxes:
                if float(box.conf[0]) < 0.5:
                    continue
                    
                class_name = self.yolo.names[int(box.cls[0])]
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                
                # Захват глубины из центра
                patch = depth_map[max(0, cy-5):min(height, cy+5), max(0, cx-5):min(width, cx+5)]
                distance = (self.depth_scale / (np.mean(patch) + 1e-6)) if patch.size > 0 else 9.9
                
                objects_data.append({
                    "class": class_name,
                    "center_x": cx,
                    "distance": float(max(0.5, distance))
                })
                
        return objects_data