"""WebSocket-сервер SpatiaVision. Протокол описан в spatia/protocol.py.

Запуск (из папки server/):
    .venv/Scripts/python -m uvicorn app:app --host 0.0.0.0 --port 8000

Если собрана веб-версия фронта (mobile/dist, `npm run build:web`), сервер
раздаёт и её: тогда фронт и /ws живут на одном адресе — нужен один туннель.
"""
import asyncio
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from spatia import Engine, Session, Settings
from spatia.config import SERVER_DIR
from spatia.protocol import Config, Error, Hello, Pose, Ready, Result, parse_frame
from spatia.schemas import Group, Obstacle

WEB_DIST = SERVER_DIR.parent / "mobile" / "dist"
HELLO_TIMEOUT_S = 10
DEBUG_MOVING = os.environ.get("SPATIA_DEBUG") == "1"  # печатать "едет на тебя" в лог

# Одна видеокарта -> один поток инференса. Все сессии обрабатываются по очереди.
gpu = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
engine: Engine | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global engine
    engine = await asyncio.get_running_loop().run_in_executor(gpu, Engine, Settings())
    print("[server] модели загружены, жду подключений на /ws")
    yield
    gpu.shutdown(wait=False, cancel_futures=True)


app = FastAPI(lifespan=lifespan)


class FrameSlot:
    """Хранит только самый свежий кадр: если пришёл новый, пока старый ждал, старый выбрасываем."""

    def __init__(self) -> None:
        self.item: tuple[int, bytes, np.ndarray | None] | None = None
        self.event = asyncio.Event()
        self.dropped = 0

    def put(self, seq: int, jpeg: bytes, up: np.ndarray | None) -> None:
        if self.item is not None:
            self.dropped += 1
        self.item = (seq, jpeg, up)
        self.event.set()

    async def take(self) -> tuple[int, bytes, np.ndarray | None]:
        await self.event.wait()
        self.event.clear()
        item, self.item = self.item, None
        assert item is not None
        return item


def process_jpeg(session: Session, jpeg: bytes, up: np.ndarray | None) -> tuple[list[Obstacle], list[Group], list[str]] | None:
    frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        return None
    max_side = session.s.max_frame_side
    if max(frame.shape[:2]) > max_side:
        k = max_side / max(frame.shape[:2])
        frame = cv2.resize(frame, (round(frame.shape[1] * k), round(frame.shape[0] * k)), interpolation=cv2.INTER_AREA)
    obstacles, dbg = session.process(frame, up=up)
    if DEBUG_MOVING:
        for o in dbg.objects:
            if o.moving and o.threat:
                print(f"[moving] {o.detection.cls}#{o.detection.track_id} d={o.distance.smoothed_m:.1f} "
                      f"approach={o.approach_mps:+.2f} own={o.own_speed_mps:+.2f} "
                      f"side={o.lateral_speed_mps:+.2f} ego={dbg.ego_speed:+.2f}")
    return obstacles, dbg.groups, list(dbg.hints)


async def send(ws: WebSocket, msg) -> None:
    await ws.send_text(msg.model_dump_json())


async def process_loop(ws: WebSocket, session: Session, slot: FrameSlot) -> None:
    loop = asyncio.get_running_loop()
    while True:
        seq, jpeg, up = await slot.take()
        t0 = loop.time()
        try:
            out = await loop.run_in_executor(gpu, process_jpeg, session, jpeg, up)
        except Exception as e:  # ошибка одного кадра не должна убивать сессию
            print(f"[server] ошибка обработки кадра {seq}: {e!r}")
            await send(ws, Error(message=f"ошибка обработки кадра {seq}"))
            continue
        if out is None:
            await send(ws, Error(message=f"кадр {seq}: не удалось декодировать JPEG"))
            continue
        obstacles, groups, hints = out
        await send(ws, Result(
            seq=seq,
            obstacles=obstacles,
            groups=groups,
            hints=hints,  # type: ignore[arg-type]
            server_ms=round((loop.time() - t0) * 1000, 1),
            dropped=slot.dropped,
        ))


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    loop = asyncio.get_running_loop()
    try:
        hello = Hello.model_validate_json(await asyncio.wait_for(ws.receive_text(), HELLO_TIMEOUT_S))
    except (asyncio.TimeoutError, ValidationError, ValueError):
        await send(ws, Error(message='первым сообщением ожидается {"type":"hello", ...}'))
        await ws.close(code=1008)
        return

    assert engine is not None
    # В gpu-потоке: может понадобиться загрузить модель для другой сцены
    session = await loop.run_in_executor(gpu, engine.new_session, hello.scene, hello.hfov)
    sid = uuid.uuid4().hex[:8]
    print(f"[server] {sid}: подключился ({hello.platform}, scene={hello.scene}, hfov={hello.hfov})")
    await send(ws, Ready(session=sid))

    slot = FrameSlot()
    pose_up: np.ndarray | None = None  # ориентация телефона для следующего кадра
    worker = asyncio.create_task(process_loop(ws, session, slot))
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                try:
                    slot.put(*parse_frame(msg["bytes"]), pose_up)
                    pose_up = None  # ориентация относится только к этому кадру
                except ValueError as e:
                    await send(ws, Error(message=str(e)))
            elif msg.get("text") is not None:
                if msg["text"].startswith('{"type":"pose"'):  # частое сообщение — без лишних попыток разбора
                    try:
                        v = np.array(Pose.model_validate_json(msg["text"]).up, dtype=np.float64)
                        n = np.linalg.norm(v)
                        pose_up = v / n if 0.5 < n < 1.5 else None  # мусор — игнорируем
                    except ValidationError:
                        pose_up = None
                    continue
                try:
                    cfg = Config.model_validate_json(msg["text"])
                except ValidationError:
                    await send(ws, Error(message="неизвестное сообщение"))
                    continue
                # Через gpu-поток, чтобы не менять настройки посреди обработки кадра
                await loop.run_in_executor(gpu, session.configure, cfg.scene, cfg.hfov)
    finally:
        worker.cancel()
        print(f"[server] {sid}: отключился, выброшено кадров: {slot.dropped}")


@app.get("/health")
def health() -> dict:
    return {"ok": engine is not None}


# Веб-версия фронта (если собрана). Монтируем последней, чтобы не перекрыть /ws.
if WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
