import { useEffect, useRef, useState } from "react";
import type { Group, Hint, Obstacle } from "../api/protocol";
import { cameraTilt, TiltAdvice } from "../sensors/cameraTilt";
import { announcer } from "./announcer";
import { haptics } from "./haptics";
import { spatialAudio } from "./spatialAudio";

/** Разблокировать звук и датчики — вызывать в обработчике нажатия (например, кнопка "Начать"). */
export function unlockAudio() {
  spatialAudio.unlock();
  announcer.unlock();
  cameraTilt.unlock();
}

interface Options {
  obstacles: Obstacle[];
  groups: Group[];
  hints: Hint[];
  active: boolean; // идёт сканирование и есть связь
  beeps: boolean;
  speech: boolean;
  vibration: boolean;
}

/** Подаёт результаты сервера в звук, вибрацию и голос. */
export function useAudioFeedback({ obstacles, groups, hints, active, beeps, speech, vibration }: Options) {
  useEffect(() => {
    spatialAudio.enabled = beeps;
    announcer.enabled = speech;
    haptics.enabled = vibration;
  }, [beeps, speech, vibration]);

  useEffect(() => {
    if (!active) return;
    spatialAudio.start();
    haptics.start();
    announcer.onSpeakingChange = (speaking) => spatialAudio.duck(speaking);
    return () => {
      spatialAudio.stop();
      haptics.stop();
      announcer.stop();
      announcer.onSpeakingChange = null;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    spatialAudio.update(obstacles);
    haptics.update(obstacles);
    announcer.update({ obstacles, groups, hints, tilt: cameraTilt.advice(Date.now()) });
  }, [obstacles, groups, hints, active]);
}

const NO_DATA_MS = 3000; // столько нет ответов сервера — "нет связи"
const NO_DATA_GRACE_MS = 8000; // после запуска даём время подключиться
const NO_DATA_REPEAT_MS = 10000;

/**
 * Сторож связи: если ответов сервера нет дольше 3 с, человек идёт "вслепую" —
 * голосом просим остановиться (повтор каждые 10 с). Возвращает true, пока связи нет.
 */
export function useConnectionWatchdog(obstacles: Obstacle[], speech: boolean): boolean {
  const [lost, setLost] = useState(false);
  const lastDataAt = useRef(0);
  useEffect(() => {
    lastDataAt.current = Date.now(); // каждый ответ сервера — новый массив
  }, [obstacles]);
  useEffect(() => {
    const startedAt = Date.now();
    let saidAt = -Infinity;
    const id = setInterval(() => {
      const now = Date.now();
      const silent = now - Math.max(lastDataAt.current, startedAt + NO_DATA_GRACE_MS - NO_DATA_MS) > NO_DATA_MS;
      setLost(silent);
      if (silent && speech && now - saidAt > NO_DATA_REPEAT_MS) {
        saidAt = now;
        announcer.sayNow("Нет связи с сервером. Остановитесь");
      }
    }, 500);
    return () => clearInterval(id);
  }, [speech]);
  return lost;
}

/** Совет по наклону телефона для экрана (обновляется дважды в секунду). */
export function useTiltAdvice(active: boolean): TiltAdvice | null {
  const [advice, setAdvice] = useState<TiltAdvice | null>(null);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setAdvice(cameraTilt.advice(Date.now())), 500);
    return () => {
      clearInterval(id);
      setAdvice(null);
    };
  }, [active]);
  return advice;
}
