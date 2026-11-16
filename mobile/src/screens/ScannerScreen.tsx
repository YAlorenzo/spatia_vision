import { useEffect, useMemo, useRef, useState } from "react";
import { Text, TouchableOpacity, View } from "react-native";
import { CameraView } from "expo-camera";
import { cssInterop } from "nativewind";
import type { Scene } from "../api/protocol";
import { getServerUrl } from "../api/serverUrl";
import { StreamStatus, useServerStream } from "../api/useServerStream";
import { ObstacleOverlay } from "../components/ObstacleOverlay";
import { useAudioFeedback, useConnectionWatchdog, useTiltAdvice } from "../audio/useAudioFeedback";
import { announcer } from "../audio/announcer";
import { course, courseText } from "../sensors/course";
import { describe, setLabelScene, URGENCY_COLOR, zonesText } from "../components/labels";

// CameraView — сторонний компонент, NativeWind должен знать, что className -> style
cssInterop(CameraView, { className: "style" });

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: "Connecting…",
  streaming: "Connected",
  reconnecting: "Reconnecting…",
  stopped: "Stopped",
};

const STATUS_DOT: Record<StreamStatus, string> = {
  connecting: "bg-amber-400",
  streaming: "bg-green-500",
  reconnecting: "bg-red-500",
  stopped: "bg-zinc-500",
};

// С какого расстояния голос говорит о неподвижном препятствии на пути (как в announcer.ts)
const STATIC_ANNOUNCE_M = 5;

interface ScannerScreenProps {
  onStop: () => void;
}

export const ScannerScreen = ({ onStop }: ScannerScreenProps) => {
  const cameraRef = useRef<CameraView | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [scene, setScene] = useState<Scene>("indoor"); // по умолчанию — помещение; на улице переключить
  const [beeps, setBeeps] = useState(true);
  const [speech, setSpeech] = useState(true);
  const [vibration, setVibration] = useState(true);
  const url = useMemo(() => getServerUrl(), []);

  const { status, obstacles, groups, hints, bypass, stats, frameSize, error } = useServerStream({
    url,
    cameraRef,
    cameraReady,
    enabled: true,
    scene,
  });

  useEffect(() => setLabelScene(scene), [scene]);

  const active = status === "streaming";
  useAudioFeedback({ obstacles, groups, hints, bypass, active, beeps, speech, vibration });
  const tilt = useTiltAdvice(active);
  const connectionLost = useConnectionWatchdog(obstacles, speech);

  const primary = obstacles.find((o) => o.primary);

  // --- Курс: направление, куда человек хочет идти ---
  const [courseDev, setCourseDev] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setCourseDev(course.deviation(Date.now())), 400);
    return () => clearInterval(id);
  }, []);
  useEffect(() => () => course.clear(), []);
  const setCourse = () => {
    announcer.sayNow(
      course.set(Date.now()) ? "Course set. Heading this way" : "Course unavailable: no rotation sensor on this phone",
    );
  };
  const clearCourse = () => {
    course.clear();
    announcer.sayNow("Course cleared");
  };

  const otherThreats = obstacles.filter((o) => o.threat && !o.primary).length;
  const notices = [
    ...(connectionLost ? ["No connection — stop"] : []),
    ...(courseDev != null ? [Math.abs(courseDev) < 12 ? "On course" : courseText(courseDev)] : []),
    // Совет обхода показываем там же, где голос его говорит: неподвижное препятствие на пути ближе 5 м
    ...(primary && primary.in_path && !primary.moving && primary.distance <= STATIC_ANNOUNCE_M
      ? bypass === "left"
        ? ["Pass on the left"]
        : bypass === "right"
          ? ["Pass on the right"]
          : bypass === "none"
            ? ["No way around in view"]
            : []
      : []),
    ...(hints.includes("too_dark") ? ["Too dark — stop"] : []),
    ...(hints.includes("blurry") ? ["Blurry image — stop"] : []),
    ...groups
      .filter((g) => g.type !== "cluster")
      .map((g) => (g.type === "crowd" ? `Group of people ${zonesText(g.zones)}` : "Parking area — caution")),
    ...(tilt === "raise" ? ["Raise the phone"] : tilt === "lower" ? ["Lower the phone"] : []),
  ];

  return (
    <View className="flex-1 bg-zinc-950">
      <CameraView
        ref={cameraRef}
        className="flex-1"
        facing="back"
        onCameraReady={() => setCameraReady(true)}
      />

      <ObstacleOverlay obstacles={obstacles} frameSize={frameSize} />

      {/* Статус соединения и переключатель сцены */}
      <View className="absolute top-4 left-4 right-4 gap-2">
        <View className="flex-row items-center justify-between rounded-2xl bg-black/60 px-4 py-2">
          <View className="flex-row items-center gap-2">
            <View className={`h-3 w-3 rounded-full ${STATUS_DOT[status]}`} />
            <Text className="text-white font-semibold">{STATUS_TEXT[status]}</Text>
          </View>
          {status === "streaming" && (
            <Text className="text-zinc-300 text-xs">
              {stats.fps.toFixed(1)} fps · {Math.round(stats.rttMs)} ms · {Math.round(stats.frameKb)} KB
            </Text>
          )}
        </View>

        <View className="flex-row flex-wrap gap-2">
          <View className="flex-row rounded-2xl bg-black/60 p-1">
            {(["indoor", "outdoor"] as const).map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => setScene(s)}
                className={`rounded-xl px-4 py-1.5 ${scene === s ? "bg-blue-500" : ""}`}
                accessibilityRole="button"
                accessibilityState={{ selected: scene === s }}
              >
                <Text className="text-white font-semibold">{s === "outdoor" ? "Outdoor" : "Indoor"}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View className="flex-row rounded-2xl bg-black/60 p-1">
            {[
              { label: "Beeps", on: beeps, toggle: () => setBeeps((v) => !v) },
              { label: "Voice", on: speech, toggle: () => setSpeech((v) => !v) },
              { label: "Vibration", on: vibration, toggle: () => setVibration((v) => !v) },
            ].map((t) => (
              <TouchableOpacity
                key={t.label}
                onPress={t.toggle}
                className={`rounded-xl px-4 py-1.5 ${t.on ? "bg-emerald-600" : ""}`}
                accessibilityRole="switch"
                accessibilityState={{ checked: t.on }}
              >
                <Text className={`font-semibold ${t.on ? "text-white" : "text-zinc-400 line-through"}`}>{t.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {notices.length > 0 && (
          <View className="flex-row flex-wrap gap-2">
            {notices.map((n) => (
              <Text key={n} className="rounded-xl bg-amber-500/90 px-3 py-1.5 text-black font-bold">
                {n}
              </Text>
            ))}
          </View>
        )}

        {error && status !== "streaming" && (
          <Text className="rounded-xl bg-red-900/80 px-3 py-2 text-white text-xs">{error}</Text>
        )}
      </View>

      {/* Курс, главная опасность, стоп */}
      <View className="absolute bottom-10 w-full items-center gap-4 px-6">
        {/* Большая кнопка, чтобы попасть не глядя: нажатие — запомнить курс, долгое — сбросить */}
        <TouchableOpacity
          className={`w-full rounded-3xl py-4 items-center ${courseDev != null ? "bg-emerald-600" : "bg-blue-600"}`}
          onPress={setCourse}
          onLongPress={clearCourse}
          accessibilityRole="button"
          accessibilityLabel="Set course: I am heading where the phone points. Long press clears the course"
        >
          <Text className="text-white text-lg font-black">
            {courseDev != null ? "Course set · hold to clear" : "Set course"}
          </Text>
        </TouchableOpacity>

        <View
          className="w-full rounded-3xl bg-black/70 px-5 py-4"
          accessibilityLiveRegion="polite"
          accessible
        >
          {primary ? (
            <Text className="text-2xl font-black text-center" style={{ color: URGENCY_COLOR[primary.urgency] }}>
              {describe(primary)}
            </Text>
          ) : (
            <Text className="text-zinc-300 text-xl font-bold text-center">
              {status === "streaming" ? "Path clear" : "Waiting for server"}
            </Text>
          )}
          {otherThreats > 0 && (
            <Text className="text-zinc-400 text-sm text-center mt-1">other hazards: {otherThreats}</Text>
          )}
        </View>

        <TouchableOpacity
          className="bg-red-500 py-5 w-4/5 rounded-3xl items-center active:bg-red-600"
          onPress={onStop}
        >
          <Text className="text-white text-2xl font-black uppercase text-center">Stop</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
