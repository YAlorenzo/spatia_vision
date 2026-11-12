import { Platform } from "react-native";
import type { Obstacle } from "../api/protocol";
import { classLabel, describe, metersRu, ZONE_RU } from "../components/labels";

/**
 * Голосовые подсказки без спама.
 *
 * Приоритеты:
 *   1. ОПАСНОСТЬ — транспорт/человек едет навстречу (moving) или столкновение < 3 с.
 *      Перебивает текущую речь. Повтор по тому же объекту — не чаще раза в 6 с.
 *   2. Новый человек / транспорт / животное ближе 6 м — один раз на объект (повтор через 15 с).
 *   3. Препятствие прямо ближе 2.5 м — повтор, если подошли заметно ближе или прошло 5 с.
 * Пока голос говорит, обычные фразы не ставятся в очередь (они прозвучат в следующий
 * раз, если ещё актуальны) — так подсказки не отстают от реальности.
 */

const DANGER_COOLDOWN_MS = 6000;
const OBJECT_COOLDOWN_MS = 15000;
const OBSTACLE_COOLDOWN_MS = 5000;
const SAME_TEXT_MS = 4000;
const NOTICE_RANGE_M = 6;
const AHEAD_RANGE_M = 2.5;

export interface Utterance {
  text: string;
  danger: boolean;
  key: string; // за что "отчитались" (id объекта)
}

/** Чистая логика выбора фразы — без браузерных API, легко проверить. */
export class AnnouncerLogic {
  private lastSaid = new Map<string, { at: number; distance: number }>();
  private lastText = { text: "", at: 0 };

  reset() {
    this.lastSaid.clear();
    this.lastText = { text: "", at: 0 };
  }

  pick(obstacles: Obstacle[], now: number, speaking: boolean): Utterance | null {
    const candidates: (Utterance & { score: number })[] = [];
    for (const o of obstacles) {
      const key = `${o.kind}:${o.id ?? o.cls + o.zone}`;
      const prev = this.lastSaid.get(key);
      const since = prev ? now - prev.at : Infinity;

      const danger = o.kind !== "obstacle" && (o.moving || (o.ttc !== null && o.ttc < 3 && o.distance < 8));
      if (danger && since > DANGER_COOLDOWN_MS) {
        const text = o.moving
          ? `Осторожно! ${classLabel(o.cls)} приближается ${ZONE_RU[o.zone]}`
          : `Осторожно! ${describe(o)}`;
        candidates.push({ text, danger: true, key, score: 100 - o.distance });
        continue;
      }
      if (o.kind !== "obstacle" && o.distance < NOTICE_RANGE_M && since > OBJECT_COOLDOWN_MS) {
        candidates.push({ text: describe(o), danger: false, key, score: 50 - o.distance });
        continue;
      }
      if (o.kind === "obstacle" && o.zone === "center" && o.distance < AHEAD_RANGE_M) {
        const closer = prev ? prev.distance - o.distance > 0.8 : true;
        if (since > OBSTACLE_COOLDOWN_MS || closer) {
          candidates.push({ text: `Препятствие прямо, ${metersRu(o.distance)}`, danger: false, key, score: 40 - o.distance });
        }
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (speaking && !best.danger) return null;
    if (best.text === this.lastText.text && now - this.lastText.at < SAME_TEXT_MS) return null;

    const o = obstacles.find((x) => `${x.kind}:${x.id ?? x.cls + x.zone}` === best.key);
    this.lastSaid.set(best.key, { at: now, distance: o?.distance ?? 0 });
    this.lastText = { text: best.text, at: now };
    return { text: best.text, danger: best.danger, key: best.key };
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
    utt.rate = 1.15;
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
