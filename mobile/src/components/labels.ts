import type { Obstacle, Urgency } from "../api/protocol";

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
};

export const URGENCY_COLOR: Record<Urgency, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

export const classLabel = (cls: string) => CLASS_RU[cls] ?? cls;

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
