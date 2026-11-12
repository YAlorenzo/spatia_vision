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
 *   4. Камера плохо видит:
 *      - смотрит в пол/небо (датчик наклона): "Поднимите телефон выше" -> через 5 с ещё раз ->
 *        через 15 с "Остановитесь…" (и каждые 15 с, пока не поднимут);
 *      - темно, размыто: "Остановитесь…" — каждые 8 с, пока не наладится.
 *   5. Обстановка: "Внимание, парковка…" (повтор каждые 30 с, пока на парковке),
 *      "Толпа людей слева и впереди".
 *   6. Объекты alert=warn: едущая машина (даже далеко), человек идёт к тебе или стоит
 *      на пути, живое/транспорт сбоку рядом. Каждый — один раз (повтор через 15 с,
 *      или сразу, если изменилась причина: стоял сбоку -> пошёл к тебе).
 *      В толпе люди по одному не озвучиваются; на парковке — стоящие машины.
 * Пока голос говорит, фразы не копятся в очередь — каждый ответ сервера выбирается
 * заново самое важное из актуального.
 */

const DANGER_COOLDOWN_MS = 5000; // по тому же объекту
const DANGER_GAP_MS = 3000; // между любыми тревогами
const SAME_PRIMARY_MS = 6000; // та же главная опасность вернулась — не повторяем сразу
const BANDS_M = [3, 1.5]; // пороги, при пересечении которых озвучиваем приближение
const WARN_REPEAT_MS = 15000; // тот же объект по той же причине
const CROWD_REPEAT_MS = 20000;
const CROWD_CHANGE_MS = 10000; // толпа сместилась — повторяем не раньше
const PARKING_REPEAT_MS = 30000; // всё ещё на парковке — напоминаем
const TILT_SECOND_MS = 5000; // вторая просьба про наклон
const TILT_STOP_MS = 15000; // потом пауза — и "Остановитесь" (повтор с тем же интервалом)
const TILT_RESET_MS = 3000; // телефон держат нормально столько — начинаем сначала
const TILT_TEXT: Record<TiltAdvice, [string, string, string]> = {
  raise: [
    "Поднимите телефон выше",
    "Поднимите телефон, камера смотрит в пол",
    "Остановитесь. Камера смотрит в пол, препятствий впереди не видно. Поднимите телефон",
  ],
  lower: [
    "Опустите телефон",
    "Опустите телефон, камера смотрит вверх",
    "Остановитесь. Камера смотрит вверх, дорогу не видно. Опустите телефон",
  ],
};
const UNCLEAR_REPEAT_MS = 8000; // камера плохо видит — просим остановиться
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
  private tiltKind: TiltAdvice | null = null;
  private tiltStage = 0; // сколько просьб про наклон уже сказано (0..3)
  private tiltAt = -Infinity;
  private tiltBadAt = 0; // когда наклон последний раз был плохим
  lastEndAt = 0; // когда закончилась последняя фраза (для паузы)

  reset() {
    this.tiltKind = null;
    this.tiltStage = 0;
    this.tiltAt = -Infinity;
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

    // 4. Камера плохо видит — по такому кадру ничего надёжно не определить: просим остановиться
    const tiltText = this.tiltAdvice(tilt, now);
    if (tiltText) return this.say(tiltText, false, now);
    const unclear = hints.includes("too_dark") ? "dark" : hints.includes("blurry") ? "blurry" : null;
    if (unclear && now - (this.adviceAt.get("unclear") ?? -Infinity) > UNCLEAR_REPEAT_MS) {
      this.adviceAt.set("unclear", now);
      return this.say(
        unclear === "dark"
          ? "Остановитесь. Слишком темно, камера плохо видит"
          : "Остановитесь. Изображение размыто, протрите камеру или держите телефон ровнее",
        false,
        now,
      );
    }

    // 5. Обстановка: парковка, толпа
    for (const g of groups) {
      const zones = g.zones.join(",");
      const prev = this.groupSaid.get(g.type);
      const repeat = g.type === "parking" ? PARKING_REPEAT_MS : CROWD_REPEAT_MS;
      // Толпа сместилась (была слева — теперь впереди) — говорим, но не чаще раза в 10 с
      const changed = g.type === "crowd" && prev != null && prev.zones !== zones && now - prev.at > CROWD_CHANGE_MS;
      if (!prev || changed || now - prev.at > repeat) {
        this.groupSaid.set(g.type, { zones, at: now });
        const again = prev != null && !changed;
        return this.say(again && g.type === "parking" ? "Вы всё ещё на парковке, осторожно" : groupRu(g), false, now);
      }
    }
    for (const t of ["crowd", "parking"]) {
      // Группа пропала — следующий раз скажем сразу
      if (!groups.some((g) => g.type === t)) this.groupSaid.delete(t);
    }

    // 6. Объекты, о которых надо сказать голосом
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

    return null;
  }

  /**
   * Камера смотрит в пол (или в небо) — по нарастающей:
   *   1-я просьба сразу; через 5 с — вторая; ещё через 15 с — "Остановитесь…",
   *   и дальше "Остановитесь…" каждые 15 с, пока телефон не поднимут.
   * Телефон держат нормально 3 с — счёт сбрасывается.
   */
  private tiltAdvice(tilt: TiltAdvice | null, now: number): string | null {
    if (!tilt) {
      if (this.tiltStage > 0 && now - this.tiltBadAt > TILT_RESET_MS) this.tiltStage = 0;
      return null;
    }
    this.tiltBadAt = now;
    if (tilt !== this.tiltKind) {
      this.tiltKind = tilt;
      this.tiltStage = 0;
    }
    const wait = [0, TILT_SECOND_MS, TILT_STOP_MS, TILT_STOP_MS][this.tiltStage];
    if (now - this.tiltAt < wait) return null;
    const stage = this.tiltStage;
    this.tiltStage = Math.min(3, stage + 1);
    this.tiltAt = now;
    return TILT_TEXT[tilt][Math.min(stage, 2)];
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

  /** Сказать сразу, мимо логики выбора (например, "нет связи" — ответов сервера нет вовсе). */
  sayNow(text: string) {
    if (!this.supported || !this.enabled) return;
    const synth = window.speechSynthesis;
    synth.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = "ru-RU";
    if (this.voice) utt.voice = this.voice;
    utt.rate = 1.25;
    synth.speak(utt);
  }

  stop() {
    this.logic.reset();
    if (this.supported) window.speechSynthesis.cancel();
    this.onSpeakingChange?.(false);
  }
}

export const announcer = new Announcer();
