import { useEffect } from "react";
import type { Obstacle } from "../api/protocol";
import { announcer } from "./announcer";
import { spatialAudio } from "./spatialAudio";

/** Разблокировать звук — вызывать в обработчике нажатия (например, кнопка "Начать"). */
export function unlockAudio() {
  spatialAudio.unlock();
  announcer.unlock();
}

interface Options {
  obstacles: Obstacle[];
  active: boolean; // идёт сканирование и есть связь
  beeps: boolean;
  speech: boolean;
}

/** Подаёт результаты сервера в звуковой движок и голос. */
export function useAudioFeedback({ obstacles, active, beeps, speech }: Options) {
  useEffect(() => {
    spatialAudio.enabled = beeps;
    announcer.enabled = speech;
  }, [beeps, speech]);

  useEffect(() => {
    if (!active) return;
    spatialAudio.start();
    announcer.onSpeakingChange = (speaking) => spatialAudio.duck(speaking);
    return () => {
      spatialAudio.stop();
      announcer.stop();
      announcer.onSpeakingChange = null;
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    spatialAudio.update(obstacles);
    announcer.update(obstacles);
  }, [obstacles, active]);
}
