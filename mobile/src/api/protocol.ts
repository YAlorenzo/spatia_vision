// Протокол WebSocket /ws v1 — зеркало server/spatia/protocol.py

export const PROTOCOL_VERSION = 1;
export const FRAME_HEADER_BYTES = 4; // uint32 big-endian: seq

export type Scene = "outdoor" | "indoor";
export type Zone = "left" | "center" | "right";
export type Urgency = "high" | "medium" | "low";

export interface Obstacle {
  id: number | null;
  cls: string;
  zone: Zone;
  pan: number; // -1 (слева) .. 1 (справа)
  distance: number; // метры
  urgency: Urgency;
  conf: number;
  box: [number, number, number, number]; // x1, y1, x2, y2 в долях кадра
}

// клиент -> сервер
export interface HelloMessage {
  type: "hello";
  v: number;
  platform: string;
  scene?: Scene;
  hfov?: number;
}

export interface ConfigMessage {
  type: "config";
  scene?: Scene;
  hfov?: number;
}

// сервер -> клиент
export interface ReadyMessage {
  type: "ready";
  v: number;
  session: string;
  max_width: number;
}

export interface ResultMessage {
  type: "result";
  seq: number;
  obstacles: Obstacle[];
  server_ms: number;
  dropped: number;
}

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage = ReadyMessage | ResultMessage | ErrorMessage;

/** base64 JPEG (можно с префиксом data:...;base64,) -> бинарный кадр [seq][JPEG]. */
export function encodeFrame(seq: number, base64: string): ArrayBuffer {
  const comma = base64.indexOf(",");
  const raw = atob(comma >= 0 ? base64.slice(comma + 1) : base64);
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES + raw.length);
  new DataView(buf).setUint32(0, seq, false);
  const bytes = new Uint8Array(buf, FRAME_HEADER_BYTES);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return buf;
}
