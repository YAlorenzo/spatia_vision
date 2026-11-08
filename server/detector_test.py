import cv2
import torch
import numpy as np
from ultralytics import YOLO

# 1. ПРОВЕРКА ВИДЕОКАРТЫ
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"\n🔥 ВЫЧИСЛЕНИЯ ИДУТ НА: {device.type.upper()}\n")

# 2. ЗАГРУЗКА YOLO (Детекция объектов)
print("Загрузка YOLO...")
yolo_model = YOLO("yolo11n.pt")
yolo_model.to(device)

# 3. ЗАГРУЗКА MIDAS (Оценка глубины)
print("Загрузка MiDaS...")
midas = torch.hub.load("intel-isl/MiDaS", "MiDaS_small")
midas.to(device)
midas.eval()

# Включаем турбо-режим (FP16) только если есть видеокарта NVIDIA
if device.type == "cuda":
    midas.half()

midas_transforms = torch.hub.load("intel-isl/MiDaS", "transforms")
transform = midas_transforms.small_transform

DEPTH_SCALE = 1500  

cap = cv2.VideoCapture("test_video.mp4")

while True:
    ret, frame = cap.read()
    if not ret:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        continue

    frame = cv2.resize(frame, (640, 480))
    height, width, _ = frame.shape
    third = width // 3

    img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

    # --- РАБОТАЕТ MIDAS ---
    input_batch = transform(img_rgb).to(device)
    # Картинка тоже должна перейти в турбо-режим, чтобы не было ошибки типа!
    if device.type == "cuda":
        input_batch = input_batch.half()
        
    with torch.no_grad():
        prediction = midas(input_batch)
        prediction = torch.nn.functional.interpolate(
            prediction.unsqueeze(1),
            size=img_rgb.shape[:2],
            mode="bicubic",
            align_corners=False,
        ).squeeze()
    
    depth_map = prediction.cpu().numpy()

    # --- РАБОТАЕТ YOLO ---
    results = yolo_model.predict(frame, verbose=False)

    for result in results:
        for box in result.boxes:
            conf = float(box.conf[0])
            if conf < 0.5:
                continue

            cls = int(box.cls[0])
            class_name = yolo_model.names[cls]
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            
            cx = (x1 + x2) // 2
            cy = (y1 + y2) // 2
            
            if cx < third:
                zone = "Ľ"
            elif cx < third * 2:
                zone = "S"
            else:
                zone = "P"

            # --- СЛИЯНИЕ ---
            patch = depth_map[max(0, cy-5):min(height, cy+5), max(0, cx-5):min(width, cx+5)]
            if patch.size > 0:
                relative_depth = np.mean(patch)
                distance = DEPTH_SCALE / (relative_depth + 1e-6)
            else:
                distance = 9.9
            
            # Я убрал лимит в 9.9 метров, как ты и просил
            distance = max(0.5, distance)

            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.circle(frame, (cx, cy), 5, (0, 0, 255), -1)
            
            label = f"{class_name} | {zone} | {distance:.1f}m"
            cv2.putText(frame, label, (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

    cv2.line(frame, (third, 0), (third, height), (255, 255, 255), 2)
    cv2.line(frame, (third * 2, 0), (third * 2, height), (255, 255, 255), 2)

    cv2.imshow("SpatiaVision - AI Depth", frame)

    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()