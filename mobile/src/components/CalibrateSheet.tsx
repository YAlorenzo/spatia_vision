import { Text, TouchableOpacity, View } from "react-native";
import type { SceneCalibration } from "../api/calibrationStore";

const DISTANCES = [1, 2, 3, 5] as const;

const distanceLabel = (meters: number) => {
  const mod = meters % 10;
  if (mod === 1 && meters % 100 !== 11) return `${meters} метр`;
  if (mod >= 2 && mod <= 4) return `${meters} метра`;
  return `${meters} метров`;
};

interface Props {
  distanceM: number;
  onDistance: (meters: number) => void;
  onApply: () => void;
  onClear: () => void;
  onClose: () => void;
  note: string | null;
  ok: boolean | null;
  saved: SceneCalibration | null;
  canApply: boolean;
}

export const CalibrateSheet = ({
  distanceM,
  onDistance,
  onApply,
  onClear,
  onClose,
  note,
  ok,
  saved,
  canApply,
}: Props) => {
  const noteColor = ok === false ? "text-amber-300" : "text-zinc-200";
  return (
    <View className="w-full rounded-3xl bg-black/80 px-5 py-4 gap-3">
      <Text className="text-white text-xl font-black text-center">Калибровка</Text>
      <Text className="text-zinc-300 text-sm text-center">
        Встаньте на известном расстоянии и наведите центр кадра на стену или человека во весь рост.
      </Text>
      <View className="flex-row justify-center gap-2">
        {DISTANCES.map((meters) => (
          <TouchableOpacity
            key={meters}
            onPress={() => onDistance(meters)}
            accessibilityRole="button"
            accessibilityLabel={distanceLabel(meters)}
            className={`rounded-2xl px-4 py-2 ${distanceM === meters ? "bg-blue-500" : "bg-white/15"}`}
          >
            <Text className="text-white font-bold">{meters} м</Text>
          </TouchableOpacity>
        ))}
      </View>
      {saved && (
        <Text className="text-zinc-400 text-xs text-center">
          Сохранено: ×{saved.depthScale.toFixed(2)}
          {saved.hfov != null ? `, угол ${Math.round(saved.hfov)}°` : ""}
        </Text>
      )}
      {note && <Text className={`${noteColor} text-sm text-center`}>{note}</Text>}
      <TouchableOpacity
        onPress={onApply}
        disabled={!canApply}
        accessibilityRole="button"
        accessibilityLabel="Калибровать по выбранному расстоянию"
        className={`py-4 rounded-2xl items-center ${canApply ? "bg-blue-500 active:bg-blue-600" : "bg-zinc-700"}`}
      >
        <Text className="text-white text-lg font-black">Готово</Text>
      </TouchableOpacity>
      <View className="flex-row gap-2">
        <TouchableOpacity
          onPress={onClear}
          accessibilityRole="button"
          accessibilityLabel="Сбросить калибровку"
          className="flex-1 py-3 rounded-2xl items-center bg-white/10"
        >
          <Text className="text-white font-semibold">Сбросить</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Закрыть калибровку"
          className="flex-1 py-3 rounded-2xl items-center bg-white/10"
        >
          <Text className="text-white font-semibold">Закрыть</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
