import { useState } from "react";
import { LayoutChangeEvent, Text, View } from "react-native";
import type { Obstacle } from "../api/protocol";
import type { FrameSize } from "../api/useServerStream";
import { classLabel, URGENCY_COLOR } from "./labels";

interface Props {
  obstacles: Obstacle[];
  frameSize: FrameSize | null;
}

/**
 * Рамки препятствий поверх превью камеры. Превью вписано как object-fit: cover,
 * поэтому пересчитываем координаты кадра в координаты экрана с тем же масштабом.
 */
export const ObstacleOverlay = ({ obstacles, frameSize }: Props) => {
  const [view, setView] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setView({ width, height });
  };

  let scale = 0;
  let offsetX = 0;
  let offsetY = 0;
  if (frameSize && view.width && view.height) {
    scale = Math.max(view.width / frameSize.width, view.height / frameSize.height);
    offsetX = (view.width - frameSize.width * scale) / 2;
    offsetY = (view.height - frameSize.height * scale) / 2;
  }

  return (
    <View className="absolute inset-0" pointerEvents="none" onLayout={onLayout}>
      {scale > 0 &&
        obstacles.map((o, i) => {
          const [bx1, y1, bx2, y2] = o.box;
          const [x1, x2] = frameSize!.mirrored ? [1 - bx2, 1 - bx1] : [bx1, bx2];
          const fw = frameSize!.width * scale;
          const fh = frameSize!.height * scale;
          const color = URGENCY_COLOR[o.urgency];
          return (
            <View
              key={o.id ?? `i${i}`}
              className="absolute rounded-lg border-2"
              style={{
                left: offsetX + x1 * fw,
                top: offsetY + y1 * fh,
                width: (x2 - x1) * fw,
                height: (y2 - y1) * fh,
                borderColor: color,
              }}
            >
              <View className="absolute -top-6 left-0 rounded px-1.5 py-0.5" style={{ backgroundColor: color }}>
                <Text className="text-xs font-bold text-black" numberOfLines={1}>
                  {classLabel(o.cls)} {o.distance.toFixed(1)} м
                </Text>
              </View>
            </View>
          );
        })}
    </View>
  );
};
