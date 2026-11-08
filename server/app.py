import cv2
import numpy as np
import base64
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from vision import VisionEngine
from logic import SpatialAnalyzer

app = FastAPI()
vision = VisionEngine()
analyzer = SpatialAnalyzer()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("📱 Устройство подключилось к Spatial Assistant!")
    
    try:
        while True:
            # 1. Принимаем кадр с телефона
            data = await websocket.receive_text()
            img_data = base64.b64decode(data)
            np_arr = np.frombuffer(img_data, np.uint8)
            frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
            
            if frame is None:
                continue
                
            # 2. Процессинг
            raw_objects = vision.process_frame(frame)
            final_data = analyzer.analyze(raw_objects, frame.shape[1])
            
            # 3. Отправляем ответ
            await websocket.send_json(final_data)
            
    except WebSocketDisconnect:
        print("❌ Устройство отключено.")
    except Exception as e:
        print(f"⚠️ Ошибка соединения: {e}")