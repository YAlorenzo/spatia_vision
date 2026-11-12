import { RefObject, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { CameraView } from "expo-camera";
import {
  clearSceneCalibration,
  loadSceneCalibration,
  saveSceneCalibration,
  type SceneCalibration,
} from "./calibrationStore";
import {
  CalibrateMessage,
  ClearCalibrationMessage,
  ConfigMessage,
  DEFAULT_HFOV,
  encodeFrame,
  HelloMessage,
  Obstacle,
  PROTOCOL_VERSION,
  ResultMessage,
  Scene,
  ServerMessage,
} from "./protocol";

const REPLY_TIMEOUT_MS = 2000; // нет ответа — шлём следующий кадр, не ждём вечно
const RECONNECT_MAX_MS = 5000;
const CAMERA_RETRY_MS = 300;
const JPEG_QUALITY = Platform.OS === "web" ? 0.6 : 0.3;

export type StreamStatus = "connecting" | "streaming" | "reconnecting" | "stopped";

export interface StreamStats {
  fps: number; // сколько кадров в секунду проходит полный круг
  rttMs: number; // от отправки кадра до ответа
  serverMs: number; // из них обработка на сервере
  frameKb: number;
}

export interface FrameSize {
  width: number;
  height: number;
  /** Превью отражено зеркально (web: камера без facingMode, напр. веб-камера ноутбука). Сам кадр — нет. */
  mirrored: boolean;
}

interface Options {
  url: string;
  cameraRef: RefObject<CameraView | null>;
  cameraReady: boolean;
  enabled: boolean;
  scene: Scene;
  hfov?: number;
}

interface StreamSettings {
  scene: Scene;
  hfov: number;
  depthScale?: number;
}

const settingsFor = (scene: Scene, hfov?: number): StreamSettings => {
  const saved = loadSceneCalibration(scene);
  return { scene, hfov: saved?.hfov ?? hfov ?? DEFAULT_HFOV, depthScale: saved?.depthScale };
};

const EMPTY_STATS: StreamStats = { fps: 0, rttMs: 0, serverMs: 0, frameKb: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ema = (prev: number, next: number) => (prev ? prev * 0.8 + next * 0.2 : next);

/**
 * Цикл "снял кадр -> отправил -> дождался ответа -> следующий".
 * Не больше одного кадра в пути: задержка минимальна, очередь не копится,
 * частота сама подстраивается под сеть и сервер.
 */
export function useServerStream({ url, cameraRef, cameraReady, enabled, scene, hfov }: Options) {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);
  const [frameSize, setFrameSize] = useState<FrameSize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [calibration, setCalibration] = useState<SceneCalibration | null>(() => loadSceneCalibration(scene));
  const [calibrationNote, setCalibrationNote] = useState<string | null>(null);
  const [calibrationOk, setCalibrationOk] = useState<boolean | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const cameraReadyRef = useRef(cameraReady);
  const settingsRef = useRef<StreamSettings>(settingsFor(scene, hfov));
  const calibToken = useRef(0);
  const calibTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    cameraReadyRef.current = cameraReady;
  }, [cameraReady]);

  // Смена сцены: подставляем сохранённую калибровку этой сцены или сбрасываем чужую.
  useEffect(() => {
    const next = settingsFor(scene, hfov);
    settingsRef.current = next;
    setCalibration(loadSceneCalibration(scene));
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const msg: ConfigMessage = {
        type: "config",
        scene,
        hfov: next.hfov,
        depth_scale: next.depthScale ?? null,
      };
      ws.send(JSON.stringify(msg));
    }
  }, [scene, hfov]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let reconnectDelay = 500;
    let scale = 1; // web: во сколько раз ужимать кадр (подбирается по первому снимку)
    let maxWidth = 640;
    let pending: { seq: number; resolve: (r: ResultMessage | null) => void } | null = null;

    const resolvePending = (r: ResultMessage | null) => {
      pending?.resolve(r);
      pending = null;
    };

    const waitReply = (seq: number) =>
      new Promise<ResultMessage | null>((resolve) => {
        pending = { seq, resolve };
        setTimeout(() => {
          if (pending?.seq === seq) resolvePending(null);
        }, REPLY_TIMEOUT_MS);
      });

    const captureFrame = async (): Promise<string | null> => {
      const camera = cameraRef.current;
      if (!camera || !cameraReadyRef.current) return null;
      const photo = await camera.takePictureAsync({
        base64: true,
        quality: JPEG_QUALITY,
        imageType: "jpg", // web по умолчанию отдаёт PNG — в разы тяжелее
        scale,
        shutterSound: false,
        skipProcessing: true,
      });
      if (!photo?.base64) return null;
      if (Platform.OS === "web" && photo.width) {
        scale = Math.min(1, maxWidth / photo.width); // width — размер исходного потока
      }
      if (photo.width && photo.height) {
        // expo-camera web считает камеру без facingMode фронтальной и зеркалит превью
        const mirrored = Platform.OS === "web" && (photo.exif?.facingMode ?? "user") === "user";
        setFrameSize((prev) =>
          prev?.width === photo.width && prev?.height === photo.height && prev?.mirrored === mirrored
            ? prev
            : { width: photo.width, height: photo.height, mirrored },
        );
      }
      return photo.base64;
    };

    const streamLoop = async (ws: WebSocket) => {
      let seq = 0;
      let lastLoop = Date.now();
      let s = EMPTY_STATS;
      while (alive && ws.readyState === WebSocket.OPEN) {
        let base64: string | null = null;
        try {
          base64 = await captureFrame();
        } catch (e) {
          console.warn("[stream] ошибка захвата кадра", e);
        }
        if (!base64) {
          await sleep(CAMERA_RETRY_MS);
          continue;
        }
        if (!alive || ws.readyState !== WebSocket.OPEN) break;

        seq += 1;
        const frame = encodeFrame(seq, base64);
        const sentAt = Date.now();
        const reply = waitReply(seq);
        ws.send(frame);
        const result = await reply;
        if (!alive) break;
        if (!result) continue; // таймаут или ошибка кадра — просто следующий

        const now = Date.now();
        s = {
          fps: ema(s.fps, 1000 / Math.max(1, now - lastLoop)),
          rttMs: ema(s.rttMs, now - sentAt),
          serverMs: ema(s.serverMs, result.server_ms),
          frameKb: ema(s.frameKb, frame.byteLength / 1024),
        };
        lastLoop = now;
        setObstacles(result.obstacles);
        setStats(s);
      }
    };

    const connect = () => {
      if (!alive) return;
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        const { scene: helloScene, hfov: helloHfov, depthScale } = settingsRef.current;
        const hello: HelloMessage = {
          type: "hello",
          v: PROTOCOL_VERSION,
          platform: Platform.OS,
          scene: helloScene,
          hfov: helloHfov,
        };
        if (depthScale != null) hello.depth_scale = depthScale;
        ws.send(JSON.stringify(hello));
      };

      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (msg.type === "ready") {
          maxWidth = msg.max_width;
          reconnectDelay = 500;
          setError(null);
          setStatus("streaming");
          streamLoop(ws);
        } else if (msg.type === "result") {
          if (pending?.seq === msg.seq) resolvePending(msg); // устаревшие ответы игнорируем
        } else if (msg.type === "calibrated") {
          calibToken.current += 1;
          if (calibTimer.current) clearTimeout(calibTimer.current);
          setCalibrationOk(msg.ok);
          setCalibrationNote(msg.message);
          if (msg.ok && msg.depth_scale != null) {
            const sceneNow = settingsRef.current.scene;
            const prev = loadSceneCalibration(sceneNow);
            const stored: SceneCalibration = {
              depthScale: msg.depth_scale,
              hfov: msg.hfov ?? prev?.hfov,
            };
            saveSceneCalibration(sceneNow, stored);
            settingsRef.current = {
              ...settingsRef.current,
              depthScale: stored.depthScale,
              hfov: stored.hfov ?? settingsRef.current.hfov,
            };
            setCalibration(stored);
          }
        } else if (msg.type === "calibration_cleared") {
          calibToken.current += 1;
          if (calibTimer.current) clearTimeout(calibTimer.current);
          clearSceneCalibration(settingsRef.current.scene);
          settingsRef.current = { ...settingsRef.current, depthScale: undefined, hfov: DEFAULT_HFOV };
          setCalibration(null);
          setCalibrationOk(true);
          setCalibrationNote("Калибровка сброшена. Снова используется автокалибровка.");
        } else if (msg.type === "error") {
          console.warn("[stream] сервер:", msg.message);
          setError(msg.message);
          resolvePending(null);
        }
      };

      ws.onerror = () => setError(`Нет связи с сервером (${url})`);

      ws.onclose = () => {
        resolvePending(null);
        if (wsRef.current === ws) wsRef.current = null;
        if (!alive) return;
        setStatus("reconnecting");
        setObstacles([]);
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };
    };

    connect();

    return () => {
      alive = false;
      resolvePending(null);
      if (calibTimer.current) clearTimeout(calibTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      setStatus("connecting"); // к следующему запуску
      setObstacles([]);
    };
  }, [url, enabled, cameraRef]);

  const calibrate = (distanceM: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setCalibrationOk(false);
      setCalibrationNote("Нет связи с сервером");
      return;
    }
    const token = ++calibToken.current;
    if (calibTimer.current) clearTimeout(calibTimer.current);
    setCalibrationOk(null);
    setCalibrationNote("Держите центр кадра на цели…");
    const msg: CalibrateMessage = { type: "calibrate", distance_m: distanceM };
    ws.send(JSON.stringify(msg));
    calibTimer.current = setTimeout(() => {
      if (calibToken.current === token) {
        setCalibrationOk(false);
        setCalibrationNote("Сервер не ответил. Повторите калибровку.");
      }
    }, 8000);
  };

  const clearCalibration = () => {
    calibToken.current += 1;
    if (calibTimer.current) clearTimeout(calibTimer.current);
    clearSceneCalibration(settingsRef.current.scene);
    settingsRef.current = { ...settingsRef.current, depthScale: undefined, hfov: DEFAULT_HFOV };
    setCalibration(null);
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      const msg: ClearCalibrationMessage = { type: "clear_calibration" };
      ws.send(JSON.stringify(msg));
      setCalibrationOk(null);
      setCalibrationNote("Сбрасываю калибровку…");
    } else {
      setCalibrationOk(true);
      setCalibrationNote("Калибровка сброшена на этом телефоне.");
    }
  };

  return {
    status: enabled ? status : ("stopped" as StreamStatus),
    obstacles,
    stats,
    frameSize,
    error,
    calibration,
    calibrationNote,
    calibrationOk,
    calibrate,
    clearCalibration,
  };
}
