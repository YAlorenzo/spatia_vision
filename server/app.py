"""WebSocket-сервер SpatiaVision.

Запуск (из папки server/):  .venv/Scripts/uvicorn app:app --host 0.0.0.0 --port 8000

Протокол с фронтом будет доработан на следующем этапе; пока сервер, как и
раньше, принимает кадр строкой base64 (JPEG) и отвечает FrameResult в JSON.
"""
import base64

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from starlette.concurrency import run_in_threadpool

from spatia import Pipeline, Settings

app = FastAPI()
pipeline = Pipeline(Settings())


def decode_frame(data: str) -> np.ndarray | None:
    buf = np.frombuffer(base64.b64decode(data), np.uint8)
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    pipeline.reset()  # новый клиент — новый трекинг и сглаживание
    print("📱 Устройство подключилось")
    try:
        while True:
            data = await websocket.receive_text()
            frame = decode_frame(data)
            if frame is None:
                continue
            # Инференс в отдельном потоке, чтобы не блокировать event loop
            result, _ = await run_in_threadpool(pipeline.process, frame)
            await websocket.send_json(result.model_dump())
    except WebSocketDisconnect:
        print("❌ Устройство отключено")
