import type { Group, Obstacle, Scene, Urgency, Zone } from "../api/protocol";

// Все тексты приложения и голоса — на английском.
const CLASS_EN: Record<string, string> = {
  person: "Person",
  bicycle: "Bicycle",
  motorcycle: "Motorcycle",
  car: "Car",
  bus: "Bus",
  truck: "Truck",
  train: "Train",
  dog: "Dog",
  cat: "Cat",
  horse: "Horse",
  cow: "Cow",
  sheep: "Sheep",
  obstacle: "Obstacle",
  // препятствия по глубине, названные по форме
  wall: "Wall",
  pole: "Pole or tree",
  low: "Low obstacle",
  // неподвижные предметы, которые знает детектор
  bench: "Bench",
  chair: "Chair",
  couch: "Couch",
  "potted plant": "Plant",
  bed: "Bed",
  "dining table": "Table",
  toilet: "Toilet",
  refrigerator: "Fridge",
  "fire hydrant": "Hydrant",
  "stop sign": "Road sign",
  "parking meter": "Parking meter",
  suitcase: "Suitcase",
  sink: "Sink",
  tv: "TV",
};

export const URGENCY_COLOR: Record<Urgency, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

// В помещении деревьев нет: узкое высокое препятствие там — просто "Pillar"
let indoor = true;
export function setLabelScene(scene: Scene) {
  indoor = scene === "indoor";
}

export const classLabel = (cls: string) => (cls === "pole" && indoor ? "Pillar" : (CLASS_EN[cls] ?? cls));

/**
 * Расстояние, которое будет верным, когда голос его договорит. Фраза звучит ~1.5 с, человек идёт —
 * без упреждения "5 meters" звучит, когда до препятствия уже 3. Берём скорость сближения с сервера.
 */
const SPEECH_LEAD_S = 0.4; // число звучит почти в начале фразы
export function spokenDistance(o: Obstacle): number {
  // удаляется или медленно — не упреждаем; больше быстрого шага — это шум
  const closing = o.approach < 0.4 ? 0 : Math.min(o.approach, 1.5);
  return Math.max(0.5, o.distance - closing * SPEECH_LEAD_S);
}

/** "1 meter", "3 meters", "one and a half meters", "less than a meter" — для речи и экрана. */
export function meters(d: number): string {
  if (d < 0.9) return "less than a meter";
  if (d < 1.25) return "1 meter";
  if (d < 1.75) return "one and a half meters";
  return `${Math.round(d)} meters`;
}

/** Где объект относительно пользователя: в коридоре движения — "ahead". */
export const where = (o: Obstacle) => (o.in_path ? "ahead" : o.bearing < 0 ? "on the left" : "on the right");

/** Буква стороны для рамки на экране: L / C / R (голосом не произносится). */
export const zoneLetter = (o: Obstacle) => (o.in_path || o.zone === "center" ? "C" : o.bearing < 0 ? "L" : "R");

/** Короткая фраза для экрана: "Chair ahead, 3 meters". */
export function describe(o: Obstacle): string {
  return `${classLabel(o.cls)}${o.moving ? " moving" : ""} ${where(o)}, ${meters(o.distance)}`;
}

/**
 * Насколько объект важен на экране:
 *   threat — на пути или едет на тебя: яркая рамка, красный / жёлтый / зелёный по срочности;
 *   watch  — человек, транспорт или животное ближе 10 м (о них предупреждаем заранее): оранжевая;
 *   idle   — всё остальное, что видно, но не угрожает: тусклая серая, чтобы не было каши.
 */
export type BoxLevel = "threat" | "watch" | "idle";
const WATCH_M = 10;

export function boxLevel(o: Obstacle): BoxLevel {
  if (o.threat) return "threat";
  if (o.kind !== "obstacle" && (o.distance <= WATCH_M || o.moving)) return "watch";
  return "idle";
}

export function boxColor(o: Obstacle): string {
  const level = boxLevel(o);
  return level === "threat" ? URGENCY_COLOR[o.urgency] : level === "watch" ? "#fb923c" : "#9ca3af";
}

const ZONE_EN: Record<Zone, string> = { left: "on the left", center: "ahead", right: "on the right" };

/** ["left","center"] -> "on the left and ahead" */
export function zonesText(zones: Zone[]): string {
  const words = zones.map((z) => ZONE_EN[z]);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Фраза об обстановке. */
export function groupText(g: Group): string {
  if (g.type === "crowd") return `Group of people ${zonesText(g.zones)}, ${meters(g.distance)}`;
  if (g.type === "cluster") return `Many objects ${zonesText(g.zones)}`;
  return "Caution, parking area";
}
