"""Тестовый клиент: стримит видео на сервер по протоколу /ws, как это делает телефон.

Позволяет проверить сервер без фронта и измерить реальную частоту/задержку.

    .venv/Scripts/python tools/ws_client.py                          # test_video -> ws://localhost:8000/ws
    .venv/Scripts/python tools/ws_client.py --url wss://xxx.trycloudflare.com/ws --seconds 20
    .venv/Scripts/python tools/ws_client.py --video 0 --scene indoor   # веб-камера
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

import cv2
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from spatia.config import SERVER_DIR  # noqa: E402
from spatia.protocol import CLIENT_MAX_WIDTH, FRAME_HEADER  # noqa: E402

REPLY_TIMEOUT_S = 2.0


def encode(frame, quality: int) -> bytes:
    h, w = frame.shape[:2]
    if w > CLIENT_MAX_WIDTH:
        frame = cv2.resize(frame, (CLIENT_MAX_WIDTH, round(h * CLIENT_MAX_WIDTH / w)), interpolation=cv2.INTER_AREA)
    ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    assert ok
    return jpeg.tobytes()


async def run(args: argparse.Namespace) -> None:
    src = int(args.video) if args.video.isdigit() else args.video
    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        sys.exit(f"не удалось открыть {args.video}")
    fps_in = cap.get(cv2.CAP_PROP_FPS) or 30
    is_file = not args.video.isdigit()

    async with websockets.connect(args.url, max_size=2**22) as ws:
        await ws.send(json.dumps({"type": "hello", "v": 1, "platform": "python-test",
                                  "scene": args.scene, "hfov": args.hfov}))
        ready = json.loads(await ws.recv())
        print("ready:", ready)
        if ready.get("type") != "ready":
            return

        rtts, sizes, server_ms = [], [], []
        seq, t_start, src_pos, loop_start = 0, time.perf_counter(), 0, time.perf_counter()
        while time.perf_counter() - t_start < args.seconds:
            if is_file:  # имитируем живую камеру: пропускаем кадры, "прошедшие" за время ожидания
                target = int((time.perf_counter() - loop_start) * fps_in)
                while src_pos < target and cap.grab():
                    src_pos += 1
            ok, frame = cap.read()
            src_pos += 1
            if not ok and is_file:  # видео закончилось — по кругу
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                src_pos, loop_start = 0, time.perf_counter()
                ok, frame = cap.read()
            if not ok:
                break
            jpeg = encode(frame, args.quality)
            seq += 1
            t0 = time.perf_counter()
            await ws.send(FRAME_HEADER.pack(seq) + jpeg)
            # Ждём ответ именно на этот кадр (stop-and-wait)
            try:
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), REPLY_TIMEOUT_S))
                    if msg["type"] == "error":
                        print("error:", msg["message"])
                        break
                    if msg["type"] == "result" and msg["seq"] == seq:
                        break
            except asyncio.TimeoutError:
                print(f"seq {seq}: нет ответа за {REPLY_TIMEOUT_S}s, шлём следующий")
                continue
            rtt = (time.perf_counter() - t0) * 1000
            rtts.append(rtt)
            sizes.append(len(jpeg))
            server_ms.append(msg.get("server_ms", 0))
            if seq % 10 == 1:
                top = ", ".join(f"{o['cls']} {o['distance']}m {o['zone']}" for o in msg["obstacles"][:3])
                print(f"seq {seq:4d}  rtt {rtt:5.0f}ms  server {msg['server_ms']:5.0f}ms  "
                      f"{len(jpeg) // 1024}KB  | {top}")

    elapsed = time.perf_counter() - t_start
    if rtts:
        print(f"\nкадров: {len(rtts)} за {elapsed:.1f}s -> {len(rtts) / elapsed:.1f} кадр/с")
        print(f"задержка (rtt): медиана {statistics.median(rtts):.0f}ms, "
              f"p90 {sorted(rtts)[int(len(rtts) * 0.9)]:.0f}ms")
        print(f"сервер: медиана {statistics.median(server_ms):.0f}ms; "
              f"кадр: медиана {statistics.median(sizes) // 1024}KB")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="ws://localhost:8000/ws")
    p.add_argument("--video", default=str(SERVER_DIR / "test_video.mp4"))
    p.add_argument("--scene", choices=["outdoor", "indoor"], default="outdoor")
    p.add_argument("--hfov", type=float, default=65)
    p.add_argument("--quality", type=int, default=60)
    p.add_argument("--seconds", type=float, default=15)
    asyncio.run(run(p.parse_args()))


if __name__ == "__main__":
    main()
