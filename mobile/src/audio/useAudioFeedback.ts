import { useEffect, useState } from "react";
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
