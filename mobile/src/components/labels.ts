import type { Group, Obstacle, Scene, Urgency, Zone } from "../api/protocol";

const CLASS_RU: Record<string, string> = {
  person: "Человек",
  bicycle: "Велосипед",
  motorcycle: "Мотоцикл",
  car: "Машина",
  bus: "Автобус",
  truck: "Грузовик",
  train: "Поезд",
  dog: "Собака",
  cat: "Кошка",
  horse: "Лошадь",
  cow: "Корова",
  sheep: "Овца",
  obstacle: "Препятствие",
  // препятствия по глубине, названные по форме
  wall: "Стена",
  pole: "Столб или дерево",
  low: "Низкое препятствие",
  // неподвижные предметы, которые знает детектор
  bench: "Скамейка",
  chair: "Стул",
  couch: "Диван",
  "potted plant": "Вазон",
  bed: "Кровать",
  "dining table": "Стол",
  toilet: "Унитаз",
  refrigerator: "Холодильник",
  "fire hydrant": "Гидрант",
  "stop sign": "Дорожный знак",
  "parking meter": "Паркомат",
  suitcase: "Чемодан",
  sink: "Раковина",
  tv: "Телевизор",
};

export const URGENCY_COLOR: Record<Urgency, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

// В помещении деревьев нет: узкое высокое препятствие там — просто "Столб"
let indoor = true;
export function setLabelScene(scene: Scene) {
  indoor = scene === "indoor";
}

export const classLabel = (cls: string) => (cls === "pole" && indoor ? "Столб" : (CLASS_RU[cls] ?? cls));

/** "1 метр", "3 метра", "5 метров", "полтора метра", "меньше метра" — для речи и экрана. */
export function metersRu(d: number): string {
  if (d < 0.9) return "меньше метра";
  if (d < 1.25) return "1 метр";
  if (d < 1.75) return "полтора метра";
  const n = Math.round(d);
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} метр`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} метра`;
  return `${n} метров`;
}

/** Где объект относительно пользователя: в коридоре движения — "впереди". */
export const whereRu = (o: Obstacle) => (o.in_path ? "впереди" : o.bearing < 0 ? "слева" : "справа");

/** Короткая фраза для экрана: "Препятствие впереди, 3 метра". */
export function describe(o: Obstacle): string {
  return `${classLabel(o.cls)}${o.moving ? " едет" : ""} ${whereRu(o)}, ${metersRu(o.distance)}`;
}

/** Цвет рамки по классу опасности: danger — по срочности, warn — оранжевый, info — голубой, фон — серый. */
export function alertColor(o: Obstacle): string {
  if (o.alert === "danger") return URGENCY_COLOR[o.urgency];
  if (o.alert === "warn") return "#fb923c";
  if (o.alert === "info") return "#38bdf8";
  return "#a1a1aa";
}

const ZONE_RU: Record<Zone, string> = { left: "слева", center: "впереди", right: "справа" };

/** ["left","center"] -> "слева и впереди" */
export function zonesRu(zones: Zone[]): string {
  const words = zones.map((z) => ZONE_RU[z]);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`;
}

/** Почему объект озвучивается (для фразы и для антиспама). */
export type WarnReason = "moving" | "coming" | "path" | "side";

export function warnReason(o: Obstacle): WarnReason {
  if (o.moving) return "moving";
  // сам идёт к тебе (машина либо едет, либо стоит — "идёт к вам" для неё не бывает)
  if (o.own_speed > 0.5 && o.kind !== "vehicle") return "coming";
  if (o.in_path) return "path";
  return "side";
}

/** Голосом для alert=warn: "Едет машина слева, 15 метров", "Человек идёт к вам справа, 6 метров". */
export function warnRu(o: Obstacle): string {
  const cls = classLabel(o.cls);
  const where = whereRu(o);
  const m = metersRu(o.distance);
  switch (warnReason(o)) {
    case "moving":
      return o.kind === "vehicle" ? `Едет ${cls.toLowerCase()} ${where}, ${m}` : `${cls} бежит ${where}, ${m}`;
    case "coming":
      return `${cls} приближается ${where}`; // коротко; дальше — только расстояние
    default:
      return `${cls} ${where}, ${m}`;
  }
}

/** Фраза об обстановке. */
export function groupRu(g: Group): string {
  if (g.type === "crowd") return `Толпа людей ${zonesRu(g.zones)}`;
  if (g.type === "cluster") return `Массивная группа объектов ${zonesRu(g.zones)}`;
  return "Внимание, парковка";
}
