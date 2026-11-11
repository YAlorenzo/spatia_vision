import type { Obstacle, Urgency, Zone } from "../api/protocol";

const CLASS_RU: Record<string, string> = {
  person: "Человек",
  bicycle: "Велосипед",
  car: "Машина",
  motorcycle: "Мотоцикл",
  bus: "Автобус",
  train: "Поезд",
  truck: "Грузовик",
  skateboard: "Скейтборд",
  "traffic light": "Светофор",
  "fire hydrant": "Гидрант",
  "stop sign": "Знак стоп",
  "parking meter": "Паркомат",
  bench: "Скамейка",
  dog: "Собака",
  cat: "Кошка",
  horse: "Лошадь",
  sheep: "Овца",
  cow: "Корова",
  bird: "Птица",
  backpack: "Рюкзак",
  umbrella: "Зонт",
  handbag: "Сумка",
  suitcase: "Чемодан",
  chair: "Стул",
  couch: "Диван",
  "potted plant": "Растение",
  bed: "Кровать",
  "dining table": "Стол",
  toilet: "Унитаз",
  tv: "Телевизор",
  sink: "Раковина",
  refrigerator: "Холодильник",
  oven: "Плита",
  microwave: "Микроволновка",
  vase: "Ваза",
};

const ZONE_RU: Record<Zone, string> = { left: "слева", center: "прямо", right: "справа" };

export const URGENCY_COLOR: Record<Urgency, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

export const classLabel = (cls: string) => CLASS_RU[cls] ?? cls;

export const describe = (o: Obstacle) =>
  `${classLabel(o.cls)}, ${o.distance.toFixed(1)} м, ${ZONE_RU[o.zone]}`;
