import { useState } from "react";
import { LayoutChangeEvent, Text, TouchableOpacity, View } from "react-native";
import type { MapView } from "../api/protocol";

/**
 * Карта местности, вид сверху: 15 x 15 м, человек в центре, направление взгляда — вверх.
 *   серые квадраты — препятствия, которые камера видела (остаются на карте);
 *   оранжевые точки — люди / транспорт сейчас;
 *   зелёная полоса 0.5 м — маршрут по курсу в обход препятствий;
 *   голубая черта — направление курса.
 * Сервер шлёт всё в осях мира (компас телефона) — поворачиваем на курс камеры, чтобы "вверх" = куда смотрю.
 */

const VIEW_M = 15;
const RINGS_M = [2.5, 5, 7.5];

interface Props {
  map: MapView | null;
  onClose: () => void;
}

export const MapPanel = ({ map, onClose }: Props) => {
  const [size, setSize] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize(Math.min(width, height));
  };
  const px = size / VIEW_M; // пикселей на метр
  const c = size / 2;
  const heading = map?.heading ?? 0;
  // мир (x восток, y север) -> экран: поворот на -heading, y вверх
  const rot = (-heading * Math.PI) / 180;
  const toScreen = (x: number, y: number) => {
    const xr = x * Math.cos(rot) - y * Math.sin(rot);
    const yr = x * Math.sin(rot) + y * Math.cos(rot);
    return { left: c + xr * px, top: c - yr * px };
  };

  const cells: { left: number; top: number }[] = [];
  if (map && size) {
    for (let i = 0; i + 1 < map.occ.length; i += 2) cells.push(toScreen(map.occ[i] * map.cell, map.occ[i + 1] * map.cell));
  }
  const cellPx = Math.max(2, (map?.cell ?? 0.25) * px);

  // маршрут — отрезки полосой 0.5 м
  const segments: { left: number; top: number; len: number; angle: number }[] = [];
  const path = map?.path ?? null;
  if (path && size) {
    for (let i = 0; i + 1 < path.length; i++) {
      const a = toScreen(path[i][0], path[i][1]);
      const b = toScreen(path[i + 1][0], path[i + 1][1]);
      const len = Math.hypot(b.left - a.left, b.top - a.top);
      segments.push({
        left: (a.left + b.left) / 2 - len / 2,
        top: (a.top + b.top) / 2,
        len,
        angle: (Math.atan2(b.top - a.top, b.left - a.left) * 180) / Math.PI,
      });
    }
  }
  const courseAngle = map?.course != null ? map.course - heading : null; // относительно "вверх", по часовой

  return (
    <View className="absolute inset-0 bg-zinc-950">
      <View className="flex-row items-center justify-between px-4 pt-4 pb-2">
        <Text className="text-white text-xl font-black">Map · 15 × 15 m</Text>
        <TouchableOpacity className="rounded-2xl bg-blue-600 px-5 py-2" onPress={onClose} accessibilityRole="button">
          <Text className="text-white font-bold">Camera</Text>
        </TouchableOpacity>
      </View>

      <View className="flex-1 items-center justify-center" onLayout={onLayout}>
        {size > 0 && (
          <View style={{ width: size, height: size, overflow: "hidden" }} className="rounded-2xl bg-zinc-900">
            {RINGS_M.map((r) => (
              <View
                key={r}
                style={{
                  position: "absolute",
                  left: c - r * px,
                  top: c - r * px,
                  width: 2 * r * px,
                  height: 2 * r * px,
                  borderRadius: r * px,
                  borderWidth: 1,
                  borderColor: "#3f3f46",
                }}
              />
            ))}
            {courseAngle != null && (
              // направление курса: отрезок от центра до края, повёрнутый вокруг своей середины
              <View
                style={{
                  position: "absolute",
                  left: c + (Math.sin((courseAngle * Math.PI) / 180) * c) / 2 - 1,
                  top: c - (Math.cos((courseAngle * Math.PI) / 180) * c) / 2 - c / 2,
                  width: 2,
                  height: c,
                  backgroundColor: "#38bdf8",
                  opacity: 0.6,
                  transform: [{ rotate: `${courseAngle}deg` }],
                }}
              />
            )}
            {cells.map((p, i) => (
              <View
                key={i}
                style={{
                  position: "absolute",
                  left: p.left - cellPx / 2,
                  top: p.top - cellPx / 2,
                  width: cellPx,
                  height: cellPx,
                  backgroundColor: "#a1a1aa",
                }}
              />
            ))}
            {segments.map((s, i) => (
              <View
                key={i}
                style={{
                  position: "absolute",
                  left: s.left,
                  top: s.top - (0.5 * px) / 2,
                  width: s.len,
                  height: 0.5 * px,
                  backgroundColor: "#22c55e",
                  opacity: 0.55,
                  borderRadius: 0.25 * px,
                  transform: [{ rotate: `${s.angle}deg` }],
                }}
              />
            ))}
            {(map?.people ?? []).map((p, i) => {
              const s = toScreen(p[0], p[1]);
              return (
                <View
                  key={`p${i}`}
                  style={{ position: "absolute", left: s.left - 6, top: s.top - 6, width: 12, height: 12, borderRadius: 6, backgroundColor: "#fb923c" }}
                />
              );
            })}
            {/* человек: треугольник "вверх" = куда смотрит камера */}
            <View
              style={{
                position: "absolute",
                left: c - 9,
                top: c - 12,
                width: 0,
                height: 0,
                borderLeftWidth: 9,
                borderRightWidth: 9,
                borderBottomWidth: 20,
                borderLeftColor: "transparent",
                borderRightColor: "transparent",
                borderBottomColor: "#ffffff",
              }}
            />
          </View>
        )}
      </View>

      <View className="px-4 pb-6 gap-1">
        <Text className="text-zinc-300 text-sm">
          {map == null
            ? "Waiting for map…"
            : map.heading == null
              ? "No compass on this phone: the map cannot follow turns"
              : map.course == null
                ? "Set a course to plan a route"
                : map.path
                  ? "Green: route around obstacles along the course"
                  : "No route along the course"}
        </Text>
        <Text className="text-zinc-500 text-xs">Gray — obstacles seen · orange — people · rings every 2.5 m</Text>
      </View>
    </View>
  );
};
