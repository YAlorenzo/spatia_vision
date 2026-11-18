// Протокол WebSocket /ws v1 — зеркало server/spatia/protocol.py

export const PROTOCOL_VERSION = 1;
export const FRAME_HEADER_BYTES = 4; // uint32 big-endian: seq

export type Scene = "outdoor" | "indoor";
export type Zone = "left" | "center" | "right";
export type Urgency = "high" | "medium" | "low";
/** person/vehicle/animal — по детектору; obstacle — по карте глубины, без класса */
export type Kind = "person" | "vehicle" | "animal" | "obstacle";
/**
 * Класс опасности:
 *   danger — угроза (главная или едет на тебя): звук;
 *   warn   — сказать голосом (едущая машина, человек идёт к тебе / на пути, живое сбоку);
 *   info   — показать цветом, молчать (люди/машины ближе 13 м);
 *   none   — фон, серым (статичное сбоку).
 */
export type Alert = "danger" | "warn" | "info" | "none";
export type GroupType = "crowd" | "parking" | "cluster"; // cluster — много предметов рядом
export type Hint = "too_dark" | "blurry";
/** С какой стороны обойти главную опасность; none — прохода в кадре не видно. */
export type Bypass = "left" | "right" | "none";

/** Карта местности (вид сверху): метры относительно человека, оси мира (x — "восток", y — "север" компаса). */
export interface MapView {
  cell: number; // размер клетки, м
  occ: number[]; // занятые клетки: [x0, y0, x1, y1, ...] в клетках
  path: [number, number][] | null; // маршрут по курсу, м
  people: [number, number][]; // люди / транспорт сейчас, м
  heading: number | null; // куда смотрит камера по компасу, градусы
  course: number | null; // курс по компасу, градусы
}

/** Обстановка: толпа людей или парковка — одним сообщением вместо каждого объекта. */
export interface Group {
  type: GroupType;
  zones: Zone[]; // center = впереди
  count: number;
  distance: number;
}

export interface Obstacle {
  id: number | null; // для obstacle: -1/-2/-3 = слева / в коридоре / справа
  kind: Kind;
  cls: string;
  zone: Zone; // center = коридор движения (в метрах), не средняя треть кадра
  pan: number; // -1 (левый край кадра) .. 1 (правый)
  bearing: number; // угол на объект, градусы: < 0 слева, > 0 справа
  distance: number; // метры
  urgency: Urgency;
  in_path: boolean; // врежешься, если идти прямо
  approach: number; // относительная скорость сближения, м/с (> 0 — приближается)
  own_speed: number; // собственная скорость к пользователю (за вычетом его ходьбы), м/с
  ttc: number | null; // эффективное время до столкновения, с (только для угроз)
  moving: boolean; // движется сам
  threat: boolean; // в коридоре или едет на пользователя
  primary: boolean; // ГЛАВНАЯ опасность — звук только о ней
  alert: Alert;
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

/**
 * Ориентация телефона для следующего кадра: "вверх" (по гравитации) в осях камеры —
 * x вправо, y вниз по картинке, z вперёд от камеры. Телефон вертикально: [0, -1, 0].
 * Шлётся перед каждым кадром, если есть датчик ориентации.
 */
export interface PoseMessage {
  type: "pose";
  up: [number, number, number] | null; // null — нет датчика ориентации
  /** Курс относительно камеры, градусы (> 0 правее): сервер выбирает сторону обхода ближе к нему. */
  course?: number | null;
  /** Для записи сессии: что делает человек и куда смотрит камера (компас, градусы). */
  motion?: "walking" | "standing" | "turning" | "unknown";
  heading?: number | null;
  map?: boolean; // прислать карту местности
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
  groups?: Group[];
  hints?: Hint[];
  bypass?: Bypass | null;
  map?: MapView | null;
  path_bearing?: number | null;
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
