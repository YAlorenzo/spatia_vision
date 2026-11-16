import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, TouchableOpacity, View } from "react-native";
import { CameraView } from "expo-camera";
import { cssInterop } from "nativewind";
import { detectTorchSupport } from "../api/brightness";
import type { Scene } from "../api/protocol";
import { getServerUrl } from "../api/serverUrl";
import { StreamStatus, useServerStream } from "../api/useServerStream";
import { CalibrateSheet } from "../components/CalibrateSheet";
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
  const [scene, setScene] = useState<Scene>("indoor");
  const [calibrating, setCalibrating] = useState(false);
  const [distanceM, setDistanceM] = useState(2);
  const [torchSupported, setTorchSupported] = useState<boolean | null>(Platform.OS === "web" ? null : true);
  const [beeps, setBeeps] = useState(true);
  const [speech, setSpeech] = useState(true);
  const [vibration, setVibration] = useState(true);
  const url = useMemo(() => getServerUrl(), []);

  const {
    status,
    obstacles,
    groups,
    hints,
    bypass,
    stats,
    frameSize,
    error,
    calibration,
    calibrationNote,
    calibrationOk,
    calibrate,
    clearCalibration,
    torchOn,
  } = useServerStream({
    url,
    cameraRef,
    cameraReady,
    enabled: true,
    scene,
  });

  const torchLabel =
    torchSupported === false ? "нету доступа к фонарику" : torchOn ? "фонарик вкл" : "фонарик выкл";

  useEffect(() => {
    if (!cameraReady || Platform.OS !== "web") return;
    let alive = true;
    const tick = () => {
      const supported = detectTorchSupport();
      if (!alive || supported == null) return;
      setTorchSupported(supported);
      window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 400);
    tick();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [cameraReady]);

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
        enableTorch={torchSupported === true && torchOn}
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
            {torchSupported !== null && (
              <View className="flex-row items-center gap-1">
                <View className={`h-2 w-2 rounded-full ${torchSupported && torchOn ? "bg-amber-300" : "bg-zinc-500"}`} />
                <Text
                  className={`text-xs font-semibold ${torchSupported && torchOn ? "text-amber-300" : "text-zinc-400"}`}
                >
                  {torchLabel}
                </Text>
              </View>
            )}
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
          <>
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
          </>
        )}

        {!calibrating && (
          <TouchableOpacity
            className="bg-white/15 py-3 w-4/5 rounded-3xl items-center"
            onPress={() => setCalibrating(true)}
            accessibilityRole="button"
            accessibilityLabel="Open distance calibration"
          >
            <Text className="text-white text-lg font-bold text-center">
              Calibrate{calibration ? ` · ×${calibration.depthScale.toFixed(2)}` : ""}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          className="bg-red-500 py-5 w-4/5 rounded-3xl items-center active:bg-red-600"
          onPress={onStop}
          accessibilityRole="button"
          accessibilityLabel="Остановить камеру"
        >
          <Text className="text-white text-2xl font-black uppercase text-center">Stop</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
