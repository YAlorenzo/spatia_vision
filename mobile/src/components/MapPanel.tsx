import { useState } from "react";
import { LayoutChangeEvent, Text, TouchableOpacity, View } from "react-native";
import type { MapView } from "../api/protocol";
import { classLabel } from "./labels";

/**
 * Карта местности, вид сверху, 15 x 15 м. Обычная карта, а не радар: она НЕ крутится вместе
 * с телефоном. "Вверх" — направление курса (или куда смотрел телефон, когда открыл карту),
 * а поворачивается стрелка-человек в центре.
 *   серые клетки — препятствия, которые камера видела (остаются на карте);
 *   подписи — что видно сейчас (стул, стена, человек…), оранжевые точки — люди;
 *   жёлтая линия — курс; зелёная полоса 0.5 м — маршрут в обход препятствий.
 * Сервер шлёт всё в метрах относительно человека, в осях мира (x — "восток", y — "север" компаса).
 */

const VIEW_M = 15;
const GRID_M = 1;
const COURSE = "#facc15"; // жёлтый — курс
const ROUTE = "#22c55e"; // зелёный — маршрут

interface Props {
  map: MapView | null;
  onClose: () => void;
}

export const MapPanel = ({ map, onClose }: Props) => {
  const [size, setSize] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize(Math.floor(Math.min(width, height) - 8));
  };
  // Куда "вверх" на карте: курс; без курса — куда смотрел телефон при первом кадре карты
  // (запоминаем при первом кадре с компасом — допустимое обновление состояния во время отрисовки)
  const [firstHeading, setFirstHeading] = useState<number | null>(null);
  if (firstHeading == null && map?.heading != null) setFirstHeading(map.heading);
  const up = map?.course ?? firstHeading ?? 0;

  const px = size / VIEW_M; // пикселей на метр
  const c = size / 2;
  const rot = (up * Math.PI) / 180; // мир -> экран: поворачиваем так, чтобы "up" смотрел вверх
  const toScreen = (x: number, y: number) => {
    const xr = x * Math.cos(rot) - y * Math.sin(rot);
    const yr = x * Math.sin(rot) + y * Math.cos(rot);
    return { left: c + xr * px, top: c - yr * px };
  };
  const inside = (p: { left: number; top: number }) => p.left >= 0 && p.left <= size && p.top >= 0 && p.top <= size;

  /** Отрезок между двумя точками карты (поворот вокруг середины — надёжно в вебе). */
  const segment = (a: { left: number; top: number }, b: { left: number; top: number }, width: number) => {
    // + ширина: соседние куски перекрываются, полоса без разрывов
    const len = Math.hypot(b.left - a.left, b.top - a.top) + width;
    return {
      position: "absolute" as const,
      left: (a.left + b.left) / 2 - len / 2,
      top: (a.top + b.top) / 2 - width / 2,
      width: len,
      height: width,
      transform: [{ rotate: `${(Math.atan2(b.top - a.top, b.left - a.left) * 180) / Math.PI}deg` }],
    };
  };

  const cells: { left: number; top: number }[] = [];
  if (map && size) {
    for (let i = 0; i + 1 < map.occ.length; i += 2) {
      const p = toScreen(map.occ[i] * map.cell, map.occ[i + 1] * map.cell);
      if (inside(p)) cells.push(p);
    }
  }
  const cellPx = Math.max(3, (map?.cell ?? 0.25) * px + 1);
  const path = map?.path ?? null;
  const heading = map?.heading ?? null;
  const arrowDeg = heading == null ? 0 : heading - up; // куда смотрит телефон относительно "вверх"
  const lines = [];
  for (let m = -Math.floor(VIEW_M / 2); m <= Math.floor(VIEW_M / 2); m += GRID_M) lines.push(m);

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
          <View style={{ width: size, height: size, overflow: "hidden", backgroundColor: "#18181b" }}>
            {/* сетка 1 м: обычная карта, не крутится */}
            {lines.map((m) => (
              <View key={`v${m}`} style={{ position: "absolute", left: c + m * px, top: 0, width: 1, height: size, backgroundColor: m === 0 ? "#3f3f46" : "#27272a" }} />
            ))}
            {lines.map((m) => (
              <View key={`h${m}`} style={{ position: "absolute", top: c - m * px, left: 0, height: 1, width: size, backgroundColor: m === 0 ? "#3f3f46" : "#27272a" }} />
            ))}

            {/* препятствия, которые камера видела */}
            {cells.map((p, i) => (
              <View
                key={i}
                style={{ position: "absolute", left: p.left - cellPx / 2, top: p.top - cellPx / 2, width: cellPx, height: cellPx, backgroundColor: "#a1a1aa" }}
              />
            ))}

            {/* курс — жёлтая линия от человека до края карты */}
            {map?.course != null && (
              <View style={{ ...segment({ left: c, top: c }, { left: c, top: 0 }, 3), backgroundColor: COURSE }} />
            )}

            {/* маршрут — зелёная полоса шириной 0.5 м */}
            {path &&
              path.slice(0, -1).map((p, i) => (
                <View
                  key={`r${i}`}
                  style={{
                    ...segment(toScreen(p[0], p[1]), toScreen(path[i + 1][0], path[i + 1][1]), Math.max(4, 0.5 * px)),
                    backgroundColor: ROUTE,
                    opacity: 0.7,
                    borderRadius: Math.max(2, 0.25 * px),
                  }}
                />
              ))}

            {/* что видно сейчас — с названиями */}
            {(map?.seen ?? []).map((o, i) => {
              const p = toScreen(o.x, o.y);
              if (!inside(p)) return null;
              const live = o.kind !== "obstacle";
              return (
                <View key={`s${i}`} style={{ position: "absolute", left: p.left - 5, top: p.top - 5, alignItems: "flex-start" }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: live ? "#fb923c" : "#e4e4e7" }} />
                  <Text style={{ color: live ? "#fb923c" : "#e4e4e7", fontSize: 10, fontWeight: "700", marginLeft: 12, marginTop: -11 }}>
                    {classLabel(o.cls)}
                  </Text>
                </View>
              );
            })}

            {/* человек: стрелка, куда смотрит телефон (контейнер с размером — поворот вокруг центра) */}
            <View
              style={{
                position: "absolute",
                left: c - 12,
                top: c - 12,
                width: 24,
                height: 24,
                alignItems: "center",
                justifyContent: "center",
                transform: [{ rotate: `${arrowDeg}deg` }],
              }}
            >
              <View
                style={{
                  width: 0,
                  height: 0,
                  borderLeftWidth: 10,
                  borderRightWidth: 10,
                  borderBottomWidth: 24,
                  borderLeftColor: "transparent",
                  borderRightColor: "transparent",
                  borderBottomColor: "#ffffff",
                }}
              />
            </View>
          </View>
        )}
      </View>

      <View className="px-4 pb-6 gap-1">
        <Text className="text-zinc-200 text-sm font-semibold">
          {map == null
            ? "Waiting for the map from the server…"
            : heading == null
              ? "No compass on this phone: the map cannot follow turns"
              : map.course == null
                ? "Press Set course to see the course and the route"
                : path
                  ? "Green: route around obstacles along the course"
                  : "No route along the course right now"}
        </Text>
        <View className="flex-row flex-wrap gap-x-4">
          <Text style={{ color: COURSE }} className="text-xs font-bold">— course</Text>
          <Text style={{ color: ROUTE }} className="text-xs font-bold">▬ route</Text>
          <Text className="text-zinc-400 text-xs">■ obstacles seen · ● people · grid 1 m</Text>
        </View>
      </View>
    </View>
  );
};
