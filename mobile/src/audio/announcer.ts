import { Platform } from "react-native";
import type { Bypass, Group, Hint, Obstacle } from "../api/protocol";
import type { TiltAdvice } from "../sensors/cameraTilt";
import { classLabel, groupRu, metersRu, warnReason, warnRu, whereRu } from "../components/labels";
import { courseRu } from "../sensors/course";

/**
 * Голосовые подсказки — по приоритету, одна фраза за раз.
 *
 * Главная задача — НЕ ПЕРЕГРУЖАТЬ. Расстояние и направление передаёт сигнал (частота, сторона),
 * голос говорит только то, чего сигнал сказать не может. Два режима:
 *
 *   КРАТКО (по умолчанию)                           ПОДРОБНО (дополнительно)
 *   - "Осторожно! Машина слева" (едет на тебя)       - препятствие дальше 4 м
 *   - препятствие на пути ближе 4 м, один раз:       - "3 метра", "полтора метра" по мере подхода
 *     "Стул впереди, 2 метра. Обход слева"           - люди/машины сбоку, стоящие на пути
 *   - проход появился позже: "Стул, обход справа"    - "Массивная группа объектов"
 *     (один раз на препятствие)                      - "Путь свободен" после каждого препятствия
 *   - едущая машина, человек идёт к тебе             - повторные советы обхода при смене стороны
 *   - парковка, толпа; камера в пол / темно
 *   - не чаще одной второстепенной фразы в 3 с
 *
 * РЕЖИМ ОСМОТРА. Камера телефона видит узко, поэтому часто "прохода не видно" — голос просит
 * повернуть телефон. Пока человек поворачивает телефон, всё, что попадает в кадр, НЕ считается
 * новым препятствием на пути (он стоит, а не идёт туда): сигнал тихий, названия не говорятся.
 * Голос ищет свободное направление: "Здесь свободно, правее. Идите сюда" — или
 * "Прохода не видно". Осмотр заканчивается, когда проход найден, человек пошёл или прошло 30 с.
 */

const DANGER_COOLDOWN_MS = 5000; // по тому же объекту
const DANGER_GAP_MS = 3000; // между любыми тревогами
const SAME_PRIMARY_MS = 6000; // та же главная опасность вернулась — не повторяем сразу
const ANNOUNCE_M = 4; // кратко: о препятствии на пути говорим, когда оно ближе этого
const BANDS_M = [3, 1.5]; // подробно: пороги, при пересечении которых озвучиваем приближение
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
const GAP_MS = 400; // пауза между фразами, чтобы не сливались
const MINOR_GAP_MS = 3000; // кратко: второстепенные фразы — не чаще
const PRIMARY_GAP_MS = 5000; // кратко: новое препятствие на пути объявляем не чаще
const INTERRUPT_M = 3; // новая главная опасность ближе — перебивает обычную фразу
const COMING_BANDS_M = [6, 3]; // подробно: приближающийся человек — "Человек, 5 метров"
const GUIDE_REPEAT_MS = 10000; // стоишь перед препятствием — совет обхода повторяется
const GUIDE_CHANGE_MS = 2500; // совет изменился
const GUIDE_SIDE_MS = 3000; // сторона обхода на ходу — не чаще
const GUIDE_FLIP_MS = 8000; // смена стороны для того же препятствия — не чаще
// Курс
const COURSE_OFF_DEG = 25; // отклонился от курса больше — подсказать
const COURSE_ON_DEG = 12; // вернулся — "на курсе"
const COURSE_HOLD_MS = 2500; // отклонение держится столько (не оглянулся на секунду)
const COURSE_REPEAT_MS = 8000;
const COURSE_BUSY_M = 3; // препятствие на пути ближе — сначала обход, потом курс
const FREE_AFTER_MS = 800; // препятствия нет столько — "путь свободен"
const FREE_STALE_MS = 5000;
// Режим осмотра
const SCAN_TIMEOUT_MS = 30000;
const SCAN_FREE_M = 3.5; // в эту сторону свободно, если на пути ничего ближе
const SCAN_FREE_HOLD_MS = 600; // ...и это держится столько (не мелькнуло)
const SCAN_TURNED_DEG = 12; // повернул телефон от исходного направления хотя бы на столько
const SCAN_FULL_DEG = 60; // осмотрел в сторону до стольких градусов
const SCAN_PROMPT_MS = 6000; // "поворачивайте дальше" — не чаще
const SCAN_WALK_MPS = 0.5; // препятствие приближается быстрее — человек пошёл, осмотр окончен

export interface Utterance {
  text: string;
  danger: boolean;
  interrupt?: boolean; // перебить текущую фразу (не тревогу)
}

export interface AnnouncerInput {
  obstacles: Obstacle[];
  groups: Group[];
  hints: Hint[];
  tilt: TiltAdvice | null;
  bypass?: Bypass | null; // с какой стороны обойти главную опасность
  calm?: boolean; // человек стоит перед препятствием
  verbose?: boolean; // режим "Подробно"
  heading?: number | null; // куда смотрит камера, градусы по часовой (ноль произвольный); null — нет датчика
  course?: number | null; // куда курс относительно камеры, градусы (> 0 правее); null — курс не задан
}

// У препятствий по глубине id — это зона (-1/-2/-3), поэтому в ключ входит и название:
// стена сменилась стулом в той же зоне — это новое препятствие, о нём надо сказать
const keyOf = (o: Obstacle) => (o.kind === "obstacle" ? `obstacle:${o.id}:${o.cls}` : `${o.kind}:${o.id ?? o.cls}`);
const norm = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const sideRu = (b: Bypass) => (b === "left" ? "слева" : "справа");

interface Scan {
  since: number;
  ref: number | null; // куда смотрела камера, когда начался осмотр
  minRel: number; // насколько осмотрел влево (градусы, <= 0)
  maxRel: number; // ...и вправо
  freeSince: number | null;
  promptAt: number;
  walking: number; // сколько кадров подряд препятствие быстро приближается
}

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
  private lastWasPrimary = false; // последняя фраза была о главной опасности
  private tiltKind: TiltAdvice | null = null;
  private tiltStage = 0; // сколько просьб про наклон уже сказано (0..3)
  private tiltAt = -Infinity;
  private tiltBadAt = 0; // когда наклон последний раз был плохим
  private comingBand = new Map<string, number>();
  // последний совет обхода: какая сторона, когда и для какого препятствия
  private guide: { bypass: Bypass | null; at: number; key?: string } = { bypass: null, at: -Infinity };
  private courseOffSince: number | null = null;
  private courseSaidAt = -Infinity;
  private courseWasOff = false;
  private bypassSaid = new Set<string>(); // препятствия, для которых совет обхода уже звучал
  private guided = false; // говорили о препятствии на пути — когда уйдёт, скажем "путь свободен"
  private lastPrimaryAt = 0;
  private scan: Scan | null = null;
  private primaryPhraseAt = -Infinity; // когда последний раз объявляли препятствие на пути
  lastEndAt = 0; // когда закончилась последняя фраза (для паузы)

  get lastPhrase() {
    return this.lastText.text;
  }

  /** Идёт осмотр (человек стоит и поворачивает телефон) — сигнал в это время тихий. */
  get scanning() {
    return this.scan != null;
  }

  reset() {
    this.scan = null;
    this.primaryPhraseAt = -Infinity;
    this.bypassSaid.clear();
    this.comingBand.clear();
    this.guide = { bypass: null, at: -Infinity };
    this.guided = false;
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

  pick(input: AnnouncerInput, now: number, speaking: boolean): Utterance | null {
    const { obstacles, groups, hints, tilt } = input;
    const bypass = input.bypass ?? null;
    const verbose = input.verbose ?? false;

    // 1. Едет на тебя — сразу, перебивая. Всегда, в любом режиме.
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
    const quiet = !speaking && now - this.lastEndAt >= GAP_MS;

    // Режим осмотра: вместо обычных фраз — поиск свободного направления
    if (this.scan) return this.scanStep(this.scan, p, input.heading ?? null, tilt, now, speaking, quiet);

    if (!p) {
      this.primaryKey = null;
      this.band = Infinity;
    }

    if (p) {
      this.lastPrimaryAt = now;
      const k = keyOf(p);
      // 2. Новая главная опасность. Кратко — только ближе 4 м: до этого о ней говорит сигнал.
      //    Близкая (< 3 м) перебивает обычную фразу — ждать некогда...
      // В тесном месте главное препятствие меняется каждую секунду (стена, стул, стол…) — кратко
      // объявляем не чаще раза в 5 с; срочность в это время передаёт сигнал.
      const rested = verbose || p.moving || now - this.primaryPhraseAt >= PRIMARY_GAP_MS;
      if (k !== this.primaryKey && rested && (verbose || p.distance <= ANNOUNCE_M || p.moving)) {
        // ...но только второстепенную (парковка, толпа, советы), не другую фразу об опасности
        const urgent = speaking && !this.lastWasDanger && !this.lastWasPrimary && p.distance < INTERRUPT_M;
        if (!quiet && !urgent) return null;
        this.primaryKey = k;
        this.band = Math.min(Infinity, ...BANDS_M.filter((b) => p.distance < b)); // уже ближе этого порога
        if (now - (this.primarySaidAt.get(k) ?? -Infinity) >= SAME_PRIMARY_MS) {
          this.primarySaidAt.set(k, now);
          this.primaryPhraseAt = now;
          this.guided = true;
          this.warnSaid.set(k, { reason: warnReason(p), at: now });
          // Сразу и совет, с какой стороны обойти (если сервер видит проход)
          const hasSide = p.in_path && (bypass === "left" || bypass === "right");
          const side = hasSide ? `. Обход ${sideRu(bypass!)}` : "";
          if (hasSide) this.bypassSaid.add(k);
          this.guide = { bypass: hasSide ? bypass : null, at: now, key: k };
          return this.say(`${classLabel(p.cls)} ${whereRu(p)}, ${metersRu(p.distance)}${side}`, false, now, urgent, true);
        }
      } else if (verbose && quiet && k === this.primaryKey) {
        // 3. Подробно: та же опасность пересекла следующий порог — коротко, одним числом
        const crossed = BANDS_M.filter((b) => b < this.band && p.distance < b);
        if (crossed.length) {
          this.band = Math.min(...crossed);
          this.primarySaidAt.set(k, now);
          return this.say(metersRu(p.distance), false, now, false, true);
        }
      }
    }

    if (!quiet) return null;

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

    // Совет обхода: то, что показано на экране, должно прозвучать. Для препятствия на пути ближе
    // 4 м говорим сторону, если для него ещё не говорили или сторона сменилась (не чаще раза в 3 с;
    // сторону сглаживает сервер). Фраза называет препятствие — отдельно его объявлять уже не нужно.
    if (p && p.in_path && !p.moving && p.distance <= ANNOUNCE_M && (bypass === "left" || bypass === "right")) {
      const k = keyOf(p);
      const fresh = this.guide.key !== k || this.guide.bypass !== bypass;
      // Для того же препятствия сторону меняем редко: "справа… слева… справа" только сбивает
      const wait = this.guide.key === k ? GUIDE_FLIP_MS : GUIDE_SIDE_MS;
      if (fresh && now - this.guide.at > wait) {
        this.guide = { bypass, at: now, key: k };
        this.primaryKey = k;
        this.primaryPhraseAt = now;
        this.guided = true;
        return this.say(`${classLabel(p.cls)}, обход ${sideRu(bypass)}`, false, now, false, true);
      }
    }

    // Стоит перед препятствием — совет, как обойти (сигнал в это время редкий и тихий)
    if (p && input.calm && p.in_path && !p.moving) {
      const b: Bypass = bypass ?? "none";
      const wait = b !== this.guide.bypass ? GUIDE_CHANGE_MS : GUIDE_REPEAT_MS;
      if (now - this.guide.at > wait) {
        this.guide = { bypass: b, at: now, key: keyOf(p) };
        this.guided = true;
        // Совет уже назвал препятствие — отдельно его не объявлять
        this.primaryKey = keyOf(p);
        this.primaryPhraseAt = now;
        if (b !== "none") return this.say(`${classLabel(p.cls)}, обойдите ${sideRu(b)}`, false, now);
        // Прохода в кадре нет — начинаем осмотр
        const h = input.heading ?? null;
        this.scan = { since: now, ref: h, minRel: 0, maxRel: 0, freeSince: null, promptAt: now, walking: 0 };
        return this.say("Прохода не видно. Медленно поворачивайте телефон влево или вправо", false, now);
      }
    }
    if (!p && this.guided && now - this.lastPrimaryAt > FREE_AFTER_MS) {
      this.guided = false;
      // давно ушло (голос был занят) — уже не новость; кратко — не говорим вовсе: сигнал и так замолчал
      if (verbose && now - this.lastPrimaryAt < FREE_STALE_MS) return this.say("Путь свободен", false, now);
    }

    // Курс: обошёл препятствие и ушёл в сторону — вернуть. Пока препятствие на пути рядом, молчим:
    // сначала обход (он и так выбирается в сторону курса), потом курс.
    const dev = input.course ?? null;
    if (dev == null) {
      this.courseOffSince = null;
      this.courseWasOff = false;
    } else if (Math.abs(dev) > COURSE_OFF_DEG) {
      this.courseOffSince ??= now;
      const busy = p != null && p.in_path && p.distance <= COURSE_BUSY_M;
      if (!busy && now - this.courseOffSince > COURSE_HOLD_MS && now - this.courseSaidAt > COURSE_REPEAT_MS) {
        this.courseSaidAt = now;
        this.courseWasOff = true;
        return this.say(courseRu(dev), false, now);
      }
    } else {
      this.courseOffSince = null;
      if (this.courseWasOff && Math.abs(dev) < COURSE_ON_DEG) {
        this.courseWasOff = false;
        this.courseSaidAt = now;
        return this.say("На курсе", false, now);
      }
    }

    // Дальше — второстепенное. Кратко: не чаще одной такой фразы в 3 с.
    if (!verbose && now - this.lastEndAt < MINOR_GAP_MS) return null;

    // 5. Обстановка: парковка, толпа (подробно — ещё и группа объектов)
    for (const g of groups) {
      if (g.type === "cluster" && !verbose) continue;
      const zones = g.zones.join(",");
      const prev = this.groupSaid.get(g.type);
      const repeat = g.type === "crowd" ? CROWD_REPEAT_MS : PARKING_REPEAT_MS; // парковка и группа объектов — раз в 30 с
      // Толпа сместилась (была слева — теперь впереди) — говорим, но не чаще раза в 10 с
      const changed = g.type === "crowd" && prev != null && prev.zones !== zones && now - prev.at > CROWD_CHANGE_MS;
      if (!prev || changed || now - prev.at > repeat) {
        this.groupSaid.set(g.type, { zones, at: now });
        const again = prev != null && !changed;
        return this.say(again && g.type === "parking" ? "Вы всё ещё на парковке, осторожно" : groupRu(g), false, now);
      }
    }
    for (const t of ["crowd", "parking", "cluster"]) {
      // Группа пропала — следующий раз скажем сразу
      if (!groups.some((g) => g.type === t)) this.groupSaid.delete(t);
    }

    // 6. Объекты, о которых надо сказать голосом. Кратко — только то, что движется к тебе.
    const crowd = groups.some((g) => g.type === "crowd");
    const parking = groups.some((g) => g.type === "parking");
    const warns = obstacles
      .filter((o) => o.alert === "warn" && !o.primary)
      .filter((o) => verbose || warnRank(o) <= 1) // едет / идёт к тебе
      .filter((o) => !(crowd && o.kind === "person" && !o.moving)) // в толпе — не по одному
      .filter((o) => !(parking && o.kind === "vehicle" && !o.moving)) // на парковке — стоящие машины не по одной
      .sort((a, b) => warnRank(a) - warnRank(b) || a.distance - b.distance);
    for (const o of warns) {
      const k = keyOf(o);
      const reason = warnReason(o);
      const prev = this.warnSaid.get(k);
      // Недавно говорили — повторяем, только если причина стала серьёзнее (стоял сбоку -> пошёл к тебе)
      if (prev && now - prev.at < WARN_REPEAT_MS && warnRankOf(reason) >= warnRankOf(prev.reason)) {
        // Подробно: тот же человек продолжает приближаться — только расстояние, коротко
        if (verbose && reason === "coming") {
          const band = this.comingBand.get(k) ?? Infinity;
          const crossed = COMING_BANDS_M.filter((b) => b < band && o.distance < b);
          if (crossed.length) {
            this.comingBand.set(k, Math.min(...crossed));
            return this.say(`${classLabel(o.cls)}, ${metersRu(o.distance)}`, false, now);
          }
        }
        continue;
      }
      if (reason === "coming") this.comingBand.set(k, Math.min(Infinity, ...COMING_BANDS_M.filter((b) => o.distance < b)));
      this.warnSaid.set(k, { reason, at: now });
      return this.say(warnRu(o), false, now);
    }

    return null;
  }

  /**
   * Осмотр: человек стоит и поворачивает телефон. То, что попадает в кадр, — не "новое
   * препятствие на пути", а ответ на вопрос "свободно ли в эту сторону".
   */
  private scanStep(sc: Scan, p: Obstacle | undefined, heading: number | null, tilt: TiltAdvice | null,
                   now: number, speaking: boolean, quiet: boolean): Utterance | null {
    const rel = heading != null && sc.ref != null ? norm(heading - sc.ref) : null;
    if (rel != null) {
      sc.minRel = Math.min(sc.minRel, rel);
      sc.maxRel = Math.max(sc.maxRel, rel);
    }
    const end = () => {
      this.scan = null;
      this.primaryKey = p ? keyOf(p) : null; // то, что сейчас в кадре, уже "известно" — не объявлять заново
      this.guide = { bypass: null, at: now };
      this.lastPrimaryAt = now;
      this.primaryPhraseAt = now; // после осмотра не объявлять сразу то, что мелькнуло в кадре
    };

    // Человек пошёл (препятствие быстро приближается) или осмотр затянулся — обычный режим
    sc.walking = p && p.in_path && p.approach > SCAN_WALK_MPS ? sc.walking + 1 : 0;
    if (sc.walking >= 3) {
      this.scan = null;
      this.primaryKey = null; // пусть обычная логика скажет, что впереди
      return null;
    }
    if (now - sc.since > SCAN_TIMEOUT_MS) {
      end();
      this.guide = { bypass: "none", at: now }; // и не начинать осмотр заново сразу же
      return null;
    }

    const blocked = p != null && p.in_path && p.distance <= SCAN_FREE_M;
    if (blocked) sc.freeSince = null;
    else sc.freeSince ??= now;
    const free = sc.freeSince != null && now - sc.freeSince >= SCAN_FREE_HOLD_MS;
    if (free && !(speaking && this.lastWasDanger)) {
      // Нашли свободное направление — сразу, перебивая "поворачивайте…"
      end();
      this.guided = false;
      if (rel == null) return this.say("Здесь свободно. Идите в эту сторону", false, now, true);
      if (Math.abs(rel) < SCAN_TURNED_DEG) return this.say("Путь свободен", false, now, true);
      return this.say(`Здесь свободно, ${rel > 0 ? "правее" : "левее"}. Идите в эту сторону`, false, now, true);
    }
    if (!quiet) return null;

    const tiltText = this.tiltAdvice(tilt, now);
    if (tiltText) return this.say(tiltText, false, now);

    if (now - sc.promptAt < SCAN_PROMPT_MS) return null;
    sc.promptAt = now;
    if (rel != null) {
      const doneR = sc.maxRel >= SCAN_FULL_DEG;
      const doneL = sc.minRel <= -SCAN_FULL_DEG;
      if (doneR && doneL) {
        end();
        this.guide = { bypass: "none", at: now };
        return this.say("Свободного прохода не видно. Попробуйте вернуться назад", false, now);
      }
      if (doneR) return this.say("Справа прохода нет. Поворачивайте телефон налево", false, now);
      if (doneL) return this.say("Слева прохода нет. Поворачивайте телефон направо", false, now);
    }
    return this.say("Здесь занято. Поворачивайте дальше", false, now);
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

  private say(text: string, danger: boolean, now: number, interrupt = false, primary = false): Utterance | null {
    if (!danger && text === this.lastText.text && now - this.lastText.at < 3000) return null;
    this.lastText = { text, at: now };
    this.lastWasDanger = danger;
    this.lastWasPrimary = primary;
    return { text, danger, interrupt };
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

  /** Идёт осмотр (человек поворачивает телефон в поисках прохода). */
  get scanning() {
    return this.enabled && this.logic.scanning;
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
    if (u.danger || u.interrupt) synth.cancel();
    const utt = new SpeechSynthesisUtterance(u.text);
    utt.lang = "ru-RU";
    if (this.voice) utt.voice = this.voice;
    utt.rate = 1.35;
    utt.volume = 1;
    utt.onstart = () => this.onSpeakingChange?.(true);
    utt.onend = utt.onerror = () => {
      this.logic.lastEndAt = Date.now();
      this.onSpeakingChange?.(false);
    };
    synth.speak(utt);
  }

  /** Повторить последнюю фразу (голосовая команда "повтори"). */
  repeat() {
    const t = this.logic.lastPhrase;
    this.sayNow(t || "Пока ничего не говорил");
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
