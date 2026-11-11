"""Прогон конвейера по видеофайлу (без фронта).

Примеры (из папки server/):
    .venv/Scripts/python tools/run_video.py                      # тестовое видео -> output/
    .venv/Scripts/python tools/run_video.py --live               # реальное время в окне (q — выход)
    .venv/Scripts/python tools/run_video.py --live --video 0     # веб-камера ноутбука
    .venv/Scripts/python tools/run_video.py --show               # окно, но каждый кадр (замедленно)
    .venv/Scripts/python tools/run_video.py --video my.mp4 --indoor --hfov 70

Результат: output/<имя>/annotated.mp4, objects.csv, summary.json
"""
import argparse
import csv
import json
import math
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from spatia import Engine, Settings  # noqa: E402
from spatia.config import DEPTH_MODELS, SERVER_DIR  # noqa: E402
from spatia.schemas import FrameDebug  # noqa: E402

URGENCY_COLORS = {"high": (40, 40, 255), "medium": (0, 200, 255), "low": (80, 220, 80)}
DEPTH_VIS_MAX_M = 25.0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--video", default=str(SERVER_DIR / "test_video.mp4"))
    p.add_argument("--indoor", action="store_true", help="Depth Anything Indoor (до 20 м)")
    p.add_argument("--hfov", type=float, default=None, help="Горизонтальный FOV камеры, град.")
    p.add_argument("--max-frames", type=int, default=0)
    p.add_argument("--name", default=None, help="Имя папки в output/")
    p.add_argument("--show", action="store_true")
    p.add_argument("--no-video", action="store_true", help="Не писать annotated.mp4")
    p.add_argument("--live", action="store_true",
                   help="Реальное время: окно + пропуск кадров, которые не успели обработать "
                        "(как с настоящей камерой). Файл не пишется.")
    return p.parse_args()


def depth_panel(depth_map: np.ndarray) -> np.ndarray:
    d = np.clip(depth_map / DEPTH_VIS_MAX_M, 0, 1)
    vis = cv2.applyColorMap(((1 - d) * 255).astype(np.uint8), cv2.COLORMAP_INFERNO)  # близко = светло
    cv2.putText(vis, f"depth: bright=near, dark>={DEPTH_VIS_MAX_M:.0f}m", (10, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    return vis


def annotate(frame: np.ndarray, dbg: FrameDebug, label: str) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]
    for x in (w // 3, 2 * w // 3):
        cv2.line(out, (x, 0), (x, h), (255, 255, 255), 1)
    for o in dbg.objects:
        x1, y1, x2, y2 = o.detection.box
        color = URGENCY_COLORS[o.urgency]
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        d = o.distance
        tid = "" if o.detection.track_id is None else f"#{o.detection.track_id} "
        main = f"{tid}{o.detection.cls} {d.smoothed_m:.1f}m {o.zone}"
        sub = f"d={d.depth_m:.1f}" if d.depth_m is not None else "d=-"
        sub += f" g={d.geometry_m:.1f}" if d.geometry_m is not None else " g=-"
        ty = max(18, y1 - 24)
        for i, text in enumerate((main, sub)):
            org = (x1, ty + i * 18)
            cv2.putText(out, text, org, cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 4)
            cv2.putText(out, text, org, cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
    t = dbg.timings_ms
    hud = (f"{label} | scale x{dbg.depth_scale:.2f} | det {t['detect']:.0f}ms "
           f"depth {t['depth']:.0f}ms total {t['total']:.0f}ms")
    cv2.putText(out, hud, (10, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 4)
    cv2.putText(out, hud, (10, h - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
    return out


def jitter_pct(values: list[float]) -> float | None:
    """Медиана |изменения| дистанции между соседними кадрами, в %."""
    if len(values) < 5:
        return None
    diffs = [abs(math.log(b / a)) for a, b in zip(values, values[1:]) if a > 0 and b > 0]
    return (math.exp(statistics.median(diffs)) - 1) * 100 if diffs else None


def main() -> None:
    args = parse_args()
    settings = Settings()
    if args.indoor:
        settings.depth_model_id = DEPTH_MODELS["indoor"]
    if args.hfov:
        settings.camera_hfov_deg = args.hfov

    name = args.name or Path(args.video).stem
    out_dir = SERVER_DIR / "output" / name
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.live:
        args.show, args.no_video = True, True

    session = Engine(settings).new_session()
    label = session.depth.name
    is_webcam = args.video.isdigit()  # --video 0 = веб-камера ноутбука
    cap = cv2.VideoCapture(int(args.video) if is_webcam else args.video)
    if not cap.isOpened():
        sys.exit(f"Не удалось открыть видео: {args.video}")
    fps_in = cap.get(cv2.CAP_PROP_FPS) or 30
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    # В live-режиме для файла пропускаем кадры, "прошедшие" пока шла обработка
    skip_frames = args.live and not is_webcam
    t_start = time.perf_counter()
    src_pos = 0

    writer = None
    rows: list[dict] = []
    timings: list[float] = []
    scales: list[float] = []
    per_track: dict[int, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))

    i = 0
    while True:
        if skip_frames:
            target = int((time.perf_counter() - t_start) * fps_in)
            while src_pos < target and cap.grab():
                src_pos += 1
        ok, frame = cap.read()
        src_pos += 1
        if not ok or (args.max_frames and i >= args.max_frames):
            break
        obstacles, dbg = session.process(frame)
        if i >= 5:  # первые кадры — прогрев CUDA
            timings.append(dbg.timings_ms["total"])
        scales.append(dbg.depth_scale)

        for o in dbg.objects:
            d = o.distance
            rows.append({
                "frame": i,
                "track_id": o.detection.track_id,
                "cls": o.detection.cls,
                "conf": round(o.detection.conf, 3),
                "zone": o.zone,
                "pan": o.pan,
                "depth_m": None if d.depth_m is None else round(d.depth_m, 3),
                "geometry_m": None if d.geometry_m is None else round(d.geometry_m, 3),
                "fused_m": round(d.fused_m, 3),
                "smoothed_m": round(d.smoothed_m, 3),
                "urgency": o.urgency,
            })
            if o.detection.track_id is not None:
                tr = per_track[o.detection.track_id]
                tr["fused"].append(d.fused_m)
                tr["smoothed"].append(d.smoothed_m)
                tr["cls"] = [o.detection.cls]
                if d.depth_m is not None and d.geometry_m is not None:
                    tr["ratio"].append(d.depth_m / d.geometry_m)

        vis = np.hstack([annotate(frame, dbg, label), depth_panel(dbg.depth_map)])
        vis = cv2.resize(vis, (vis.shape[1] * 3 // 4, vis.shape[0] * 3 // 4))
        if not args.no_video:
            if writer is None:
                writer = cv2.VideoWriter(str(out_dir / "annotated.mp4"),
                                         cv2.VideoWriter_fourcc(*"mp4v"), fps_in, (vis.shape[1], vis.shape[0]))
            writer.write(vis)
        if args.show:
            cv2.imshow("SpatiaVision", vis)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
        if i % 50 == 0:
            print(f"  кадр {src_pos}/{total if total > 0 else '?'}  {dbg.timings_ms['total']:.0f}ms  объектов: {len(obstacles)}")
        i += 1

    cap.release()
    if writer is not None:
        writer.release()
    cv2.destroyAllWindows()

    with open(out_dir / "objects.csv", "w", newline="", encoding="utf-8") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    tracks = []
    for tid, tr in per_track.items():
        if len(tr["fused"]) < 10:
            continue
        tracks.append({
            "id": tid,
            "cls": tr["cls"][0],
            "frames": len(tr["fused"]),
            "median_m": round(statistics.median(tr["smoothed"]), 2),
            "range_m": [round(min(tr["smoothed"]), 2), round(max(tr["smoothed"]), 2)],
            "jitter_raw_pct": round(jitter_pct(tr["fused"]) or 0, 1),
            "jitter_out_pct": round(jitter_pct(tr["smoothed"]) or 0, 1),
            "depth_to_geometry": round(statistics.median(tr["ratio"]), 2) if tr["ratio"] else None,
        })
    tracks.sort(key=lambda t: -t["frames"])

    def med(key: str) -> float | None:
        vals = [t[key] for t in tracks]
        return round(statistics.median(vals), 1) if vals else None

    summary = {
        "video": args.video,
        "depth_model": session.depth.name,
        "frames": i,
        "ms_per_frame": round(statistics.mean(timings), 1) if timings else None,
        "fps": round(1000 / statistics.mean(timings), 1) if timings else None,
        "hfov_deg": settings.camera_hfov_deg,
        "depth_scale_final": round(scales[-1], 3) if scales else None,
        "tracks_10plus_frames": len(tracks),
        "median_jitter_raw_pct": med("jitter_raw_pct"),
        "median_jitter_out_pct": med("jitter_out_pct"),
        "tracks": tracks,
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "tracks"}, ensure_ascii=False, indent=2))
    print(f"Готово: {out_dir}")


if __name__ == "__main__":
    main()
