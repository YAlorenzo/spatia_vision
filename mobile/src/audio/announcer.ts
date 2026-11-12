import { Platform } from "react-native";
import type { Obstacle } from "../api/protocol";
import { classLabel, metersRu, whereRu } from "../components/labels";

/**
 * Голосовые подсказки — только о главном, без спама.
 *
 *   1. ОПАСНОСТЬ: что-то ЕДЕТ на тебя ("Осторожно! Машина слева"). Перебивает речь.
 *      Повтор по тому же объекту — не чаще раза в 5 с.
 *   2. Новая ГЛАВНАЯ опасность (primary): "Препятствие впереди, 3 метра".
 *   3. Та же главная опасность стала ближе (пересекла 3 м, 1.5 м) — одно короткое число: "Полтора метра".
 * Всё остальное (объекты сбоку, стоящие машины) — молчит. Пока голос говорит,
 * обычные фразы не ставятся в очередь — они прозвучат, если ещё будут актуальны.
 */

const DANGER_COOLDOWN_MS = 5000;
const SAME_PRIMARY_MS = 6000; // та же главная опасность вернулась — не повторяем сразу
const BANDS_M = [3, 1.5]; // пороги, при пересечении которых озвучиваем приближение

export interface Utterance {
  text: string;
  danger: boolean;
}

const keyOf = (o: Obstacle) => `${o.kind}:${o.id ?? o.cls}`;

/** Чистая логика выбора фразы — без браузерных API. */
export class AnnouncerLogic {
  private dangerAt = new Map<string, number>();
  private primaryKey: string | null = null;
  private primarySaidAt = new Map<string, number>();
  private band = Infinity; // самый близкий порог, который главная опасность уже пересекла
  private lastText = { text: "", at: 0 };

  reset() {
    this.dangerAt.clear();
    this.primarySaidAt.clear();
    this.primaryKey = null;
    this.band = Infinity;
    this.lastText = { text: "", at: 0 };
  }

  pick(obstacles: Obstacle[], now: number, speaking: boolean): Utterance | null {
    // 1. Едет на тебя
    const danger = obstacles
      .filter((o) => o.moving && o.threat && o.kind !== "obstacle")
      .sort((a, b) => (a.ttc ?? 99) - (b.ttc ?? 99))[0];
    if (danger) {
      const k = keyOf(danger);
      if (now - (this.dangerAt.get(k) ?? -Infinity) > DANGER_COOLDOWN_MS) {
        this.dangerAt.set(k, now);
        return this.say(`Осторожно! ${classLabel(danger.cls)} ${whereRu(danger)}`, true, now);
      }
    }

    const p = obstacles.find((o) => o.primary);
    if (!p) {
      this.primaryKey = null;
      this.band = Infinity;
      return null;
    }
    if (speaking) return null;
    const k = keyOf(p);

    // 2. Новая главная опасность
    if (k !== this.primaryKey) {
      this.primaryKey = k;
      this.band = Math.min(Infinity, ...BANDS_M.filter((b) => p.distance < b)); // уже ближе этого порога
      if (now - (this.primarySaidAt.get(k) ?? -Infinity) < SAME_PRIMARY_MS) return null;
      this.primarySaidAt.set(k, now);
      return this.say(`${classLabel(p.cls)} ${whereRu(p)}, ${metersRu(p.distance)}`, false, now);
    }

    // 3. Та же опасность пересекла следующий порог — коротко, одним числом
    const crossed = BANDS_M.filter((b) => b < this.band && p.distance < b);
    if (crossed.length) {
      this.band = Math.min(...crossed);
      this.primarySaidAt.set(k, now);
      return this.say(metersRu(p.distance), false, now);
    }
    return null;
  }

  private say(text: string, danger: boolean, now: number): Utterance | null {
    if (!danger && text === this.lastText.text && now - this.lastText.at < 3000) return null;
    this.lastText = { text, at: now };
    return { text, danger };
  }
}

class Announcer {
  private logic = new AnnouncerLogic();
  private voice: SpeechSynthesisVoice | null = null;
  enabled = true;
  onSpeakingChange: ((speaking: boolean) => void) | null = null;

  get supported() {
    return Platform.OS === "web" && typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /** Вызывать из обработчика нажатия (мобильные браузеры требуют жест для первой речи). */
  unlock() {
    if (!this.supported) return;
    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      this.voice = voices.find((v) => v.lang.toLowerCase().startsWith("ru")) ?? null;
    };
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
    const warm = new SpeechSynthesisUtterance("");
    warm.volume = 0;
    window.speechSynthesis.speak(warm);
  }

  update(obstacles: Obstacle[]) {
    if (!this.supported || !this.enabled) return;
    const synth = window.speechSynthesis;
    const u = this.logic.pick(obstacles, Date.now(), synth.speaking);
    if (!u) return;
    if (u.danger) synth.cancel();
    const utt = new SpeechSynthesisUtterance(u.text);
    utt.lang = "ru-RU";
    if (this.voice) utt.voice = this.voice;
    utt.rate = 1.25;
    utt.volume = 1;
    utt.onstart = () => this.onSpeakingChange?.(true);
    utt.onend = utt.onerror = () => this.onSpeakingChange?.(false);
    synth.speak(utt);
  }

  stop() {
    this.logic.reset();
    if (this.supported) window.speechSynthesis.cancel();
    this.onSpeakingChange?.(false);
  }
}

export const announcer = new Announcer();
