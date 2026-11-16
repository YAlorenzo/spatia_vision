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
import { spatialAudio } from "../audio/spatialAudio";
import { course, courseRu } from "../sensors/course";
import { listenOnce, parseCommand, voiceSupported } from "../sensors/voiceCommands";
import { describe, setLabelScene, URGENCY_COLOR, zonesRu } from "../components/labels";

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
  const [scene, setScene] = useState<Scene>("indoor"); // по умолчанию — помещение; на улице переключить
  const [beeps, setBeeps] = useState(true);
  const [speech, setSpeech] = useState(true);
  const [vibration, setVibration] = useState(true);
  const [verbose, setVerbose] = useState(false); // голос: кратко по умолчанию
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
  useAudioFeedback({ obstacles, groups, hints, bypass, active, beeps, speech, vibration, verbose });
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
      course.set(Date.now())
        ? "Курс запомнен. Иду в эту сторону"
        : "Курс недоступен: нет датчика поворота телефона",
    );
  };
  const clearCourse = () => {
    course.clear();
    announcer.sayNow("Курс сброшен");
  };
  const whereCourse = () => {
    const dev = course.deviation(Date.now());
    announcer.sayNow(dev == null ? "Курс не задан" : Math.abs(dev) < 12 ? "Вы на курсе" : courseRu(dev));
  };

  // --- Голосовые команды (по нажатию кнопки, одна фраза) ---
  const [listening, setListening] = useState(false);
  const stateRef = useRef({ primary, bypass });
  useEffect(() => {
    stateRef.current = { primary, bypass };
  }, [primary, bypass]);
  const listen = () => {
    if (listening) return;
    if (!voiceSupported()) {
      announcer.sayNow("Голосовые команды в этом браузере не работают");
      return;
    }
    window.speechSynthesis?.cancel();
    spatialAudio.duck(true); // чтобы микрофон не ловил сигналы
    setListening(true);
    listenOnce((text, err) => {
      setListening(false);
      spatialAudio.duck(false);
      const cmd = text ? parseCommand(text) : null;
      if (!cmd) {
        announcer.sayNow(
          err === "not-allowed"
            ? "Нет доступа к микрофону"
            : "Не понял. Команды: курс, сброс курса, куда, что впереди, подробно, кратко, повтори",
        );
        return;
      }
      if (cmd === "course") setCourse();
      else if (cmd === "clear_course") clearCourse();
      else if (cmd === "where") whereCourse();
      else if (cmd === "repeat") announcer.repeat();
      else if (cmd === "verbose") {
        setVerbose(true);
        announcer.sayNow("Говорю подробно");
      } else if (cmd === "brief") {
        setVerbose(false);
        announcer.sayNow("Говорю кратко");
      } else if (cmd === "ahead") {
        const st = stateRef.current;
        const side = st.bypass === "left" ? ". Обход слева" : st.bypass === "right" ? ". Обход справа" : "";
        announcer.sayNow(st.primary ? describe(st.primary) + side : "Впереди свободно");
      }
    });
  };
  const otherThreats = obstacles.filter((o) => o.threat && !o.primary).length;
  const notices = [
    ...(connectionLost ? ["Нет связи — остановитесь"] : []),
    ...(listening ? ["Слушаю команду…"] : []),
    ...(courseDev != null ? [Math.abs(courseDev) < 12 ? "На курсе" : `${courseRu(courseDev)} (${Math.abs(Math.round(courseDev))}°)`] : []),
    // Совет обхода показываем там же, где голос его говорит: препятствие на пути ближе 4 м
    ...(primary && primary.in_path && primary.distance <= 4
      ? bypass === "left" ? ["Обход слева"] : bypass === "right" ? ["Обход справа"] : bypass === "none" ? ["Прохода не видно"] : []
      : []),
    ...(hints.includes("too_dark") ? ["Темно — остановитесь"] : []),
    ...(hints.includes("blurry") ? ["Размыто — остановитесь"] : []),
    ...groups.map((g) =>
      g.type === "crowd"
        ? `Толпа ${zonesRu(g.zones)}`
        : g.type === "cluster"
          ? `Группа объектов ${zonesRu(g.zones)}`
          : "Парковка — осторожно",
    ),
    ...(tilt === "raise" ? ["Поднимите телефон выше"] : tilt === "lower" ? ["Опустите телефон"] : []),
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
              {stats.fps.toFixed(1)} к/с · {Math.round(stats.rttMs)} мс · {Math.round(stats.frameKb)} КБ
            </Text>
          )}
        </View>

        <View className="flex-row flex-wrap gap-2">
          <View className="flex-row rounded-2xl bg-black/60 p-1">
            {(["outdoor", "indoor"] as const).map((s) => (
              <TouchableOpacity
                key={s}
                onPress={() => setScene(s)}
                className={`rounded-xl px-4 py-1.5 ${scene === s ? "bg-blue-500" : ""}`}
                accessibilityRole="button"
                accessibilityState={{ selected: scene === s }}
              >
                <Text className="text-white font-semibold">{s === "outdoor" ? "Улица" : "Помещение"}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View className="flex-row rounded-2xl bg-black/60 p-1">
            {[
              { label: "Звук", on: beeps, toggle: () => setBeeps((v) => !v) },
              { label: "Голос", on: speech, toggle: () => setSpeech((v) => !v) },
              { label: "Вибро", on: vibration, toggle: () => setVibration((v) => !v) },
              { label: "Подробно", on: verbose, toggle: () => setVerbose((v) => !v) },
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

      {/* Главная опасность + стоп */}
      <View className="absolute bottom-10 w-full items-center gap-4 px-6">
        {/* Курс и голосовая команда — большие кнопки, чтобы попасть не глядя */}
        <View className="w-full flex-row gap-3">
          <TouchableOpacity
            className={`flex-1 rounded-3xl py-4 items-center ${courseDev != null ? "bg-emerald-600" : "bg-blue-600"}`}
            onPress={setCourse}
            onLongPress={clearCourse}
            accessibilityRole="button"
            accessibilityLabel="Запомнить курс: иду туда, куда направлен телефон. Долгое нажатие — сбросить курс"
          >
            <Text className="text-white text-lg font-black">{courseDev != null ? "Курс задан" : "Задать курс"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            className={`flex-1 rounded-3xl py-4 items-center ${listening ? "bg-amber-500" : "bg-zinc-700"}`}
            onPress={listen}
            accessibilityRole="button"
            accessibilityLabel="Голосовая команда"
          >
            <Text className="text-white text-lg font-black">{listening ? "Слушаю…" : "Команда"}</Text>
          </TouchableOpacity>
        </View>

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
              {status === "streaming" ? "Путь свободен" : "Ожидание сервера"}
            </Text>
          )}
          {otherThreats > 0 && (
            <Text className="text-zinc-400 text-sm text-center mt-1">ещё опасностей: {otherThreats}</Text>
          )}
        </View>

        <TouchableOpacity
          className="bg-red-500 py-5 w-4/5 rounded-3xl items-center active:bg-red-600"
          onPress={onStop}
        >
          <Text className="text-white text-2xl font-black uppercase text-center">Остановить</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
