import { useMemo, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { CameraView } from "expo-camera";
import { cssInterop } from "nativewind";
import type { Scene } from "../api/protocol";
import { getServerUrl } from "../api/serverUrl";
import { StreamStatus, useServerStream } from "../api/useServerStream";
import { CalibrateSheet } from "../components/CalibrateSheet";
import { ObstacleOverlay } from "../components/ObstacleOverlay";
import { describe, URGENCY_COLOR } from "../components/labels";

// CameraView — сторонний компонент, NativeWind должен знать, что className -> style
cssInterop(CameraView, { className: "style" });

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: "Подключение…",
  streaming: "На связи",
  reconnecting: "Переподключение…",
  stopped: "Остановлено",
};

const STATUS_DOT: Record<StreamStatus, string> = {
  connecting: "bg-amber-400",
  streaming: "bg-green-500",
  reconnecting: "bg-red-500",
  stopped: "bg-zinc-500",
};

interface ScannerScreenProps {
  onStop: () => void;
}

export const ScannerScreen = ({ onStop }: ScannerScreenProps) => {
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [scene, setScene] = useState<Scene>("outdoor");
  const [calibrating, setCalibrating] = useState(false);
  const [distanceM, setDistanceM] = useState(2);
  const url = useMemo(() => getServerUrl(), []);

  const {
    status,
    obstacles,
    stats,
    frameSize,
    error,
    calibration,
    calibrationNote,
    calibrationOk,
    calibrate,
    clearCalibration,
  } = useServerStream({
    url,
    cameraRef,
    cameraReady,
    enabled: true,
    scene,
  });

  const nearest = obstacles[0];

  return (
    <View className="flex-1 bg-zinc-950">
      <CameraView
        ref={cameraRef}
        className="flex-1"
        facing="back"
        onCameraReady={() => setCameraReady(true)}
      />

      <ObstacleOverlay obstacles={obstacles} frameSize={frameSize} />

      {calibrating && (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <View className="h-16 w-16 rounded-full border-2 border-white items-center justify-center">
            <View className="h-2 w-2 rounded-full bg-white" />
          </View>
        </View>
      )}

      {/* Статус соединения и переключатель сцены */}
      <View className="absolute top-4 left-4 right-4 gap-2">
        <View className="flex-row items-center justify-between rounded-2xl bg-black/60 px-4 py-2">
          <View className="flex-row items-center gap-2">
            <View className={`h-3 w-3 rounded-full ${STATUS_DOT[status]}`} />
            <Text className="text-white font-semibold">{STATUS_TEXT[status]}</Text>
          </View>
          {status === "streaming" && (
            <Text className="text-zinc-300 text-xs">
              {stats.fps.toFixed(1)} к/с · {Math.round(stats.rttMs)} мс · {Math.round(stats.frameKb)} КБ
            </Text>
          )}
        </View>

        <View className="flex-row self-start rounded-2xl bg-black/60 p-1">
          {(["outdoor", "indoor"] as const).map((s) => (
            <TouchableOpacity
              key={s}
              onPress={() => setScene(s)}
              className={`rounded-xl px-4 py-1.5 ${scene === s ? "bg-blue-500" : ""}`}
            >
              <Text className="text-white font-semibold">{s === "outdoor" ? "Улица" : "Помещение"}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {error && status !== "streaming" && (
          <Text className="rounded-xl bg-red-900/80 px-3 py-2 text-white text-xs">{error}</Text>
        )}
      </View>

      {/* Ближайшее препятствие + стоп */}
      <View className="absolute bottom-10 w-full items-center gap-3 px-6">
        {calibrating ? (
          <CalibrateSheet
            distanceM={distanceM}
            onDistance={setDistanceM}
            onApply={() => calibrate(distanceM)}
            onClear={clearCalibration}
            onClose={() => setCalibrating(false)}
            note={calibrationNote}
            ok={calibrationOk}
            saved={calibration}
            canApply={status === "streaming"}
          />
        ) : (
          <View
            className="w-full rounded-3xl bg-black/70 px-5 py-4"
            accessibilityLiveRegion="polite"
            accessible
          >
            {nearest ? (
              <Text className="text-2xl font-black text-center" style={{ color: URGENCY_COLOR[nearest.urgency] }}>
                {describe(nearest)}
              </Text>
            ) : (
              <Text className="text-zinc-300 text-xl font-bold text-center">
                {status === "streaming" ? "Препятствий не видно" : "Ожидание сервера"}
              </Text>
            )}
            {obstacles.length > 1 && (
              <Text className="text-zinc-400 text-sm text-center mt-1">ещё объектов: {obstacles.length - 1}</Text>
            )}
          </View>
        )}

        {!calibrating && (
          <TouchableOpacity
            className="bg-white/15 py-3 w-4/5 rounded-3xl items-center"
            onPress={() => setCalibrating(true)}
            accessibilityRole="button"
            accessibilityLabel="Открыть калибровку расстояния"
          >
            <Text className="text-white text-lg font-bold text-center">
              Калибровка{calibration ? ` · ×${calibration.depthScale.toFixed(2)}` : ""}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          className="bg-red-500 py-5 w-4/5 rounded-3xl items-center active:bg-red-600"
          onPress={onStop}
          accessibilityRole="button"
          accessibilityLabel="Остановить камеру"
        >
          <Text className="text-white text-2xl font-black uppercase text-center">Остановить</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
