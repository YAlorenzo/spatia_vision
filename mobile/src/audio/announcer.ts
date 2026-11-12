import { Platform } from "react-native";
import type { Group, Hint, Obstacle } from "../api/protocol";
import type { TiltAdvice } from "../sensors/cameraTilt";
import { classLabel, groupRu, metersRu, warnReason, warnRu, whereRu } from "../components/labels";

/**
 * Голосовые подсказки — по приоритету, одна фраза за раз, без спама.
 *
 *   1. ОПАСНОСТЬ: что-то ЕДЕТ на тебя ("Осторожно! Машина слева"). Перебивает речь.
 *   2. Новая ГЛАВНАЯ опасность (primary): "Препятствие впереди, 3 метра".
 *   3. Главная опасность стала ближе (пересекла 3 м, 1.5 м): "Полтора метра".
 *   4. Обстановка: "Внимание, парковка…", "Толпа людей слева и впереди".
 *   5. Объекты alert=warn: едущая машина (даже далеко), человек идёт к тебе или стоит
 *      на пути, живое/транспорт сбоку рядом. Каждый — один раз (повтор через 15 с,
 *      или сразу, если изменилась причина: стоял сбоку -> пошёл к тебе).
 *      В толпе люди по одному не озвучиваются; на парковке — стоящие машины.
 *   6. Советы: "Поднимите телефон выше", "Слишком темно".
 * Пока голос говорит, фразы не копятся в очередь — каждый ответ сервера выбирается
 * заново самое важное из актуального.
 */

const DANGER_COOLDOWN_MS = 5000; // по тому же объекту
const DANGER_GAP_MS = 3000; // между любыми тревогами
const SAME_PRIMARY_MS = 6000; // та же главная опасность вернулась — не повторяем сразу
const BANDS_M = [3, 1.5]; // пороги, при пересечении которых озвучиваем приближение
const WARN_REPEAT_MS = 15000; // тот же объект по той же причине
const CROWD_REPEAT_MS = 20000;
const PARKING_REPEAT_MS = 60000;
const TILT_REPEAT_MS = 10000;
const DARK_REPEAT_MS = 30000;
const GAP_MS = 700; // пауза между обычными фразами, чтобы не сливались

export interface Utterance {
  text: string;
  danger: boolean;
}

export interface AnnouncerInput {
  obstacles: Obstacle[];
  groups: Group[];
  hints: Hint[];
  tilt: TiltAdvice | null;
}

const keyOf = (o: Obstacle) => `${o.kind}:${o.id ?? o.cls}`;

/** Чистая логика выбора фразы — без браузерных API. */
export class AnnouncerLogic {
  private dangerAt = new Map<string, number>();
  private primaryKey: string | null = null;
  private primarySaidAt = new Map<string, number>();
  private band = Infinity; // самый близкий порог, который главная опасность уже пересекла
  private warnSaid = new Map<string, { reason: string; at: number }>();
  private groupSaid = new Map<string, { zones: string; at: number }>();
  private adviceAt = new Map<string, number>();
  private lastText = { text: "", at: 0 };
  private lastDangerAt = -Infinity;
  private lastWasDanger = false;
  lastEndAt = 0; // когда закончилась последняя фраза (для паузы)

  reset() {
    this.dangerAt.clear();
    this.primarySaidAt.clear();
    this.warnSaid.clear();
    this.groupSaid.clear();
    this.adviceAt.clear();
    this.primaryKey = null;
    this.band = Infinity;
    this.lastText = { text: "", at: 0 };
    this.lastDangerAt = -Infinity;
    this.lastWasDanger = false;
    this.lastEndAt = 0;
  }

  pick({ obstacles, groups, hints, tilt }: AnnouncerInput, now: number, speaking: boolean): Utterance | null {
    // 1. Едет на тебя — сразу, перебивая
    const danger = obstacles
      .filter((o) => o.moving && o.threat && o.kind !== "obstacle")
      .sort((a, b) => (a.ttc ?? 99) - (b.ttc ?? 99))[0];
    if (danger) {
      const k = keyOf(danger);
      // Тревога не перебивает тревогу: "Осторожно! Машина сл… Осторожно! Машина спр…" — каша
      const dangerFree = now - this.lastDangerAt > DANGER_GAP_MS && !(speaking && this.lastWasDanger);
      if (dangerFree && now - (this.dangerAt.get(k) ?? -Infinity) > DANGER_COOLDOWN_MS) {
        this.dangerAt.set(k, now);
        this.lastDangerAt = now;
        this.warnSaid.set(k, { reason: "moving", at: now }); // не повторять тем же как warn
        return this.say(`Осторожно! ${classLabel(danger.cls)} ${whereRu(danger)}`, true, now);
      }
    }

    const p = obstacles.find((o) => o.primary);
    if (!p) {
      this.primaryKey = null;
      this.band = Infinity;
    }
    if (speaking || now - this.lastEndAt < GAP_MS) return null;

    if (p) {
      const k = keyOf(p);
      // 2. Новая главная опасность
      if (k !== this.primaryKey) {
        this.primaryKey = k;
        this.band = Math.min(Infinity, ...BANDS_M.filter((b) => p.distance < b)); // уже ближе этого порога
        if (now - (this.primarySaidAt.get(k) ?? -Infinity) >= SAME_PRIMARY_MS) {
          this.primarySaidAt.set(k, now);
          this.warnSaid.set(k, { reason: warnReason(p), at: now });
          return this.say(`${classLabel(p.cls)} ${whereRu(p)}, ${metersRu(p.distance)}`, false, now);
        }
      } else {
        // 3. Та же опасность пересекла следующий порог — коротко, одним числом
        const crossed = BANDS_M.filter((b) => b < this.band && p.distance < b);
        if (crossed.length) {
          this.band = Math.min(...crossed);
          this.primarySaidAt.set(k, now);
          return this.say(metersRu(p.distance), false, now);
        }
      }
    }

    // 4. Обстановка: парковка, толпа
    for (const g of groups) {
      const zones = g.zones.join(",");
      const prev = this.groupSaid.get(g.type);
      const repeat = g.type === "parking" ? PARKING_REPEAT_MS : CROWD_REPEAT_MS;
      // Толпа сместилась (была слева — теперь впереди) — говорим сразу
      const changed = g.type === "crowd" && prev != null && prev.zones !== zones;
      if (!prev || changed || now - prev.at > repeat) {
        this.groupSaid.set(g.type, { zones, at: now });
        return this.say(groupRu(g), false, now);
      }
    }
    for (const t of ["crowd", "parking"]) {
      // Группа пропала — следующий раз скажем сразу
      if (!groups.some((g) => g.type === t)) this.groupSaid.delete(t);
    }

    // 5. Объекты, о которых надо сказать голосом
    const crowd = groups.some((g) => g.type === "crowd");
    const parking = groups.some((g) => g.type === "parking");
    const warns = obstacles
      .filter((o) => o.alert === "warn" && !o.primary)
      .filter((o) => !(crowd && o.kind === "person" && !o.moving)) // в толпе — не по одному
      .filter((o) => !(parking && o.kind === "vehicle" && !o.moving)) // на парковке — стоящие машины не по одной
      .sort((a, b) => warnRank(a) - warnRank(b) || a.distance - b.distance);
    for (const o of warns) {
      const k = keyOf(o);
      const reason = warnReason(o);
      const prev = this.warnSaid.get(k);
      // Недавно говорили — повторяем, только если причина стала серьёзнее (стоял сбоку -> пошёл к тебе)
      if (prev && now - prev.at < WARN_REPEAT_MS && warnRankOf(reason) >= warnRankOf(prev.reason)) continue;
      this.warnSaid.set(k, { reason, at: now });
      return this.say(warnRu(o), false, now);
    }

    // 6. Советы
    if (tilt) {
      const text = tilt === "raise" ? "Поднимите телефон выше" : "Опустите телефон, камера смотрит вверх";
      if (now - (this.adviceAt.get(tilt) ?? -Infinity) > TILT_REPEAT_MS) {
        this.adviceAt.set(tilt, now);
        return this.say(text, false, now);
      }
    }
    if (hints.includes("too_dark") && now - (this.adviceAt.get("dark") ?? -Infinity) > DARK_REPEAT_MS) {
      this.adviceAt.set("dark", now);
      return this.say("Слишком темно, камера плохо видит", false, now);
    }
    return null;
  }

  private say(text: string, danger: boolean, now: number): Utterance | null {
    if (!danger && text === this.lastText.text && now - this.lastText.at < 3000) return null;
    this.lastText = { text, at: now };
    this.lastWasDanger = danger;
    return { text, danger };
  }
}

// Чем меньше, тем важнее
const warnRankOf = (r: string) => ({ moving: 0, coming: 1, path: 2, side: 3 })[r] ?? 4;
const warnRank = (o: Obstacle) => warnRankOf(warnReason(o));

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

  update(input: AnnouncerInput) {
    if (!this.supported || !this.enabled) return;
    const synth = window.speechSynthesis;
    const u = this.logic.pick(input, Date.now(), synth.speaking);
    if (!u) return;
    if (u.danger) synth.cancel();
    const utt = new SpeechSynthesisUtterance(u.text);
    utt.lang = "ru-RU";
    if (this.voice) utt.voice = this.voice;
    utt.rate = 1.25;
    utt.volume = 1;
    utt.onstart = () => this.onSpeakingChange?.(true);
    utt.onend = utt.onerror = () => {
      this.logic.lastEndAt = Date.now();
      this.onSpeakingChange?.(false);
    };
    synth.speak(utt);
  }

  stop() {
    this.logic.reset();
    if (this.supported) window.speechSynthesis.cancel();
    this.onSpeakingChange?.(false);
  }
}

export const announcer = new Announcer();
