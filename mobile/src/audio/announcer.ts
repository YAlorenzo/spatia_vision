import { Platform } from "react-native";
import type { Bypass, Group, Hint, Obstacle } from "../api/protocol";
import type { TiltAdvice } from "../sensors/cameraTilt";
import { classLabel, groupText, meters, spokenDistance } from "../components/labels";
import { courseText } from "../sensors/course";

/**
 * Голосовые подсказки (на английском) — по приоритету, одна фраза за раз.
 *
 * Главная задача — НЕ ПЕРЕГРУЖАТЬ: сигнал передаёт срочность, голос — что это, где и как далеко.
 * В каждой фразе об объекте есть расстояние.
 *
 *   1. "Warning! Car, 6 meters left" — что-то едет/бежит на тебя. Перебивает речь.
 *   2. Препятствие НА ПУТИ: неподвижное — с 5 м, человек/транспорт/животное — с 10 м.
 *      "Chair, 3 meters. Pass left" (на пути — без слова "ahead"). Не чаще раза в 5 с.
 *   3. Сторона обхода появилась или сменилась: "Chair, 2 meters. Pass right".
 *   4. Камера плохо видит: "Raise the phone", "Stop. Too dark…".
 *   5. Курс: "Turn left 40 degrees", "On course".
 *   6. Заранее о живом и движущемся (не чаще фразы в 3 с):
 *      люди и животные — с 10 м: "Person, 8 meters right", "Person approaching, 9 meters";
 *      группа людей — одной фразой: "Group of people, 9 meters left";
 *      едущий транспорт — как только сервер его заметил (до 20 м): "Car moving, 15 meters left";
 *      стоящий транспорт — с 5 м; на парковке — "Caution, parking area" вместо каждой машины.
 *
 * РЕЖИМ ОСМОТРА. Камера телефона видит узко, поэтому часто прохода в кадре нет — голос просит
 * повернуть телефон. Пока человек поворачивает телефон, всё, что попадает в кадр, НЕ считается
 * новым препятствием на пути (он стоит, а не идёт туда): сигнал тихий, названия не говорятся.
 * "Clear here, to the right. Go this way" — или "No way through". Осмотр заканчивается, когда
 * проход найден, человек пошёл или прошло 30 с.
 */

const DANGER_COOLDOWN_MS = 5000; // по тому же объекту
const DANGER_GAP_MS = 3000; // между любыми тревогами
const SAME_PRIMARY_MS = 6000; // та же главная опасность вернулась — не повторяем сразу
const STATIC_ANNOUNCE_M = 5; // неподвижное — говорим с этого расстояния
const DYNAMIC_ANNOUNCE_M = 10; // люди, животные (и транспорт на пути) — заранее
const PRIMARY_GAP_MS = 4000; // новое препятствие на пути объявляем не чаще
const URGENT_M = 2.5; // ...а близкое —
const URGENT_GAP_MS = 1500; // не чаще этого
const NEAR_M = 2; // то же препятствие стало ближе — короткое уточнение
const INTERRUPT_M = 3; // новая главная опасность ближе — перебивает обычную фразу
const NOTICE_REPEAT_MS = 20000; // тот же человек/машина — не чаще
const CROWD_REPEAT_MS = 20000;
const CROWD_CHANGE_MS = 10000; // группа сместилась — повторяем не раньше
const PARKING_REPEAT_MS = 30000; // всё ещё на парковке — напоминаем
const TILT_SECOND_MS = 5000; // вторая просьба про наклон
const TILT_STOP_MS = 15000; // потом пауза — и "Stop" (повтор с тем же интервалом)
const TILT_RESET_MS = 3000; // телефон держат нормально столько — начинаем сначала
const TILT_TEXT: Record<TiltAdvice, [string, string, string]> = {
  raise: [
    "Raise the phone",
    "Raise the phone, the camera is pointing at the floor",
    "Stop. The camera is pointing at the floor and cannot see ahead. Raise the phone",
  ],
  lower: [
    "Lower the phone",
    "Lower the phone, the camera is pointing up",
    "Stop. The camera is pointing up and cannot see the path. Lower the phone",
  ],
};
const UNCLEAR_REPEAT_MS = 8000; // камера плохо видит — просим остановиться
const GAP_MS = 400; // пауза между фразами, чтобы не сливались
const MINOR_GAP_MS = 3000; // второстепенные фразы — не чаще
const GUIDE_REPEAT_MS = 20000; // стоишь перед препятствием — совет обхода повторяется
const SETTLED_MS = 1500; // стоит и не крутит телефон столько — можно советовать по тому, что перед ним
const GUIDE_CHANGE_MS = 2500; // совет изменился
const GUIDE_SIDE_MS = 3000; // сторона обхода на ходу — не чаще
const GUIDE_FLIP_MS = 8000; // смена стороны для того же препятствия — не чаще
// Курс
const COURSE_OFF_DEG = 25; // отклонился от курса больше — подсказать
const COURSE_ON_DEG = 12; // вернулся — "on course"
const COURSE_HOLD_MS = 2500; // отклонение держится столько (не оглянулся на секунду)
const COURSE_REPEAT_MS = 8000;
const COURSE_BUSY_M = 3; // препятствие на пути ближе — сначала обход, потом курс
// Режим осмотра
const SCAN_TIMEOUT_MS = 30000;
const SCAN_FREE_M = 3.5; // в эту сторону свободно, если на пути ничего ближе
const SCAN_FREE_HOLD_MS = 600; // ...и это держится столько (не мелькнуло)
const SCAN_TURNED_DEG = 12; // повернул телефон от исходного направления хотя бы на столько
const SCAN_FULL_DEG = 60; // осмотрел в сторону до стольких градусов
const SCAN_PROMPT_MS = 6000; // "keep turning" — не чаще
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
  heading?: number | null; // куда смотрит камера, градусы по часовой (ноль произвольный); null — нет датчика
  course?: number | null; // куда курс относительно камеры, градусы (> 0 правее); null — курс не задан
  gait?: "walking" | "standing" | "unknown"; // по акселерометру телефона
  turning?: boolean; // телефон поворачивают (компас), > 25°/с
}

// У препятствий по глубине id — это зона (-1/-2/-3), поэтому в ключ входит и название:
// стена сменилась стулом в той же зоне — это новое препятствие, о нём надо сказать
const keyOf = (o: Obstacle) => (o.kind === "obstacle" ? `obstacle:${o.id}:${o.cls}` : `${o.kind}:${o.id ?? o.cls}`);
const norm = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const passText = (b: Bypass) => `Pass ${b}`; // коротко: длинная фраза устаревает, пока звучит
/** Расстояние с упреждением на время речи. */
const dist = (o: Obstacle) => meters(spokenDistance(o));
/** С какого расстояния говорим об объекте. */
const announceRange = (o: Obstacle) => (o.kind === "obstacle" ? STATIC_ANNOUNCE_M : DYNAMIC_ANNOUNCE_M);

// Прямо по курсу — без слова: по умолчанию всё, о чём говорим, впереди. Сторону называем, только если сбоку.
const sideWord = (o: Obstacle) => (o.in_path ? "" : o.bearing < 0 ? " left" : " right");

/** "Person approaching, 8 meters" / "Car moving, 15 meters left" / "Person, 6 meters right". */
function noticeText(o: Obstacle): string {
  const state = o.moving
    ? o.kind === "vehicle" ? " moving" : " running"
    : o.kind !== "vehicle" && o.own_speed > 0.5 ? " approaching" : "";
  return `${classLabel(o.cls)}${state}, ${dist(o)}${sideWord(o)}`;
}

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
  private primaryPhraseAt = -Infinity; // когда последний раз объявляли препятствие на пути
  private noticeAt = new Map<string, number>(); // о каких людях/машинах уже сказали
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
  // последний совет обхода: какая сторона, когда и для какого препятствия
  private guide: { bypass: Bypass | null; at: number; key?: string } = { bypass: null, at: -Infinity };
  private courseOffSince: number | null = null;
  private courseSaidAt = -Infinity;
  private courseWasOff = false;
  private scan: Scan | null = null;
  private saidDist = new Map<string, number>(); // на каком расстоянии объявили препятствие
  private nearSaid: string | null = null; // для какого препятствия уже было уточнение вблизи
  private settledSince: number | null = null; // стоит и не поворачивается — с этого момента
  private standHeading: number | null = null; // куда смотрел, пока стоял неподвижно
  private standBlocked = false; // стоял перед препятствием на пути
  lastEndAt = 0; // когда закончилась последняя фраза (для паузы)

  /** Идёт осмотр (человек стоит и поворачивает телефон) — сигнал в это время тихий. */
  get scanning() {
    return this.scan != null;
  }

  reset() {
    this.scan = null;
    this.settledSince = null;
    this.standHeading = null;
    this.standBlocked = false;
    this.saidDist.clear();
    this.nearSaid = null;
    this.primaryPhraseAt = -Infinity;
    this.guide = { bypass: null, at: -Infinity };
    this.tiltKind = null;
    this.tiltStage = 0;
    this.tiltAt = -Infinity;
    this.dangerAt.clear();
    this.primarySaidAt.clear();
    this.noticeAt.clear();
    this.groupSaid.clear();
    this.adviceAt.clear();
    this.primaryKey = null;
    this.lastText = { text: "", at: 0 };
    this.lastDangerAt = -Infinity;
    this.lastWasDanger = false;
    this.lastEndAt = 0;
    this.courseOffSince = null;
    this.courseWasOff = false;
  }

  pick(input: AnnouncerInput, now: number, speaking: boolean): Utterance | null {
    const { obstacles, groups, hints, tilt } = input;
    const bypass = input.bypass ?? null;

    // 1. Едет на тебя — сразу, перебивая
    const danger = obstacles
      .filter((o) => o.moving && o.threat && o.kind !== "obstacle")
      .sort((a, b) => (a.ttc ?? 99) - (b.ttc ?? 99))[0];
    if (danger) {
      const k = keyOf(danger);
      // Тревога не перебивает тревогу — иначе каша
      const dangerFree = now - this.lastDangerAt > DANGER_GAP_MS && !(speaking && this.lastWasDanger);
      if (dangerFree && now - (this.dangerAt.get(k) ?? -Infinity) > DANGER_COOLDOWN_MS) {
        this.dangerAt.set(k, now);
        this.lastDangerAt = now;
        this.noticeAt.set(k, now); // не повторять тем же как обычное оповещение
        return this.say(`Warning! ${classLabel(danger.cls)}, ${dist(danger)}${sideWord(danger)}`, true, now);
      }
    }

    const p = obstacles.find((o) => o.primary);
    const quiet = !speaking && now - this.lastEndAt >= GAP_MS;

    // Что делает человек. Датчика нет — "стоит" по картинке (препятствие не приближается).
    const gait = input.gait ?? "unknown";
    const turning = input.turning ?? false;
    const standing = gait === "standing" || (gait === "unknown" && (input.calm ?? false));
    const h = input.heading ?? null;
    if (standing && !turning) {
      this.settledSince ??= now;
      this.standHeading = h;
      this.standBlocked = p != null && p.in_path && !p.moving && p.distance <= STATIC_ANNOUNCE_M;
    } else {
      this.settledSince = null;
    }
    const settled = this.settledSince != null && now - this.settledSince >= SETTLED_MS;

    // Пошёл — осмотр окончен, обычный режим (о том, что на пути, скажем заново)
    if (this.scan && gait === "walking") {
      this.scan = null;
      this.primaryKey = null;
    }
    // Стоял перед препятствием и начал поворачивать телефон — это осмотр, даже без просьбы
    if (!this.scan && standing && turning && this.standBlocked) {
      this.scan = { since: now, ref: this.standHeading ?? h, minRel: 0, maxRel: 0, freeSince: null, promptAt: now, walking: 0 };
    }

    // Режим осмотра: вместо обычных фраз — поиск свободного направления
    if (this.scan) return this.scanStep(this.scan, p, input.heading ?? null, tilt, now, speaking, quiet);

    if (!p) this.primaryKey = null;

    if (p) {
      const k = keyOf(p);
      // 2. Новое препятствие на пути: неподвижное — с 5 м, живое/транспорт — с 10 м.
      //    В тесном месте препятствия меняются каждую секунду — объявляем не чаще раза в 5 с;
      //    срочность в это время передаёт сигнал.
      // Близкое (< 2.5 м) ждёт меньше: иначе о нём скажем, когда человек уже у него
      const sinceLast = now - this.primaryPhraseAt;
      const rested = p.moving || sinceLast >= PRIMARY_GAP_MS || (p.distance < URGENT_M && sinceLast >= URGENT_GAP_MS);
      // Стоит или крутит телефон — не объявляем то, на что навелась камера (стоя — совет ниже)
      const lookingAround = turning || (standing && !p.moving);
      if (k !== this.primaryKey && rested && !lookingAround && (p.distance <= announceRange(p) || p.moving)) {
        // Близкая (< 3 м) перебивает второстепенную фразу, но не другую фразу об опасности
        const urgent = speaking && !this.lastWasDanger && !this.lastWasPrimary && p.distance < INTERRUPT_M;
        if (!quiet && !urgent) return null;
        this.primaryKey = k;
        if (now - (this.primarySaidAt.get(k) ?? -Infinity) >= SAME_PRIMARY_MS) {
          this.primarySaidAt.set(k, now);
          this.primaryPhraseAt = now;
          this.noticeAt.set(k, now);
          this.saidDist.set(k, p.distance);
          // Сразу и совет, с какой стороны обойти (если сервер видит проход)
          const hasSide = p.in_path && (bypass === "left" || bypass === "right");
          this.guide = { bypass: hasSide ? bypass : null, at: now, key: k };
          const side = hasSide ? `. ${passText(bypass!)}` : "";
          return this.say(`${noticeText(p)}${side}`, false, now, urgent, true);
        }
      }
    }

    // Уточнение вблизи: о препятствии сказали издалека ("5 meters") — на 2 м коротко напомнить
    if (p && quiet && !standing && !turning && p.in_path && !p.moving && keyOf(p) === this.primaryKey && p.distance <= NEAR_M
        && this.nearSaid !== keyOf(p) && (this.saidDist.get(keyOf(p)) ?? 0) > NEAR_M + 0.7) {
      this.nearSaid = keyOf(p);
      this.primaryPhraseAt = now;
      return this.say(`${classLabel(p.cls)}, ${dist(p)}`, false, now, false, true);
    }

    if (!quiet) return null;

    // 3. Камера плохо видит — по такому кадру ничего надёжно не определить: просим остановиться
    const tiltText = this.tiltAdvice(tilt, now);
    if (tiltText) return this.say(tiltText, false, now);
    const unclear = hints.includes("too_dark") ? "dark" : hints.includes("blurry") ? "blurry" : null;
    if (unclear && now - (this.adviceAt.get("unclear") ?? -Infinity) > UNCLEAR_REPEAT_MS) {
      this.adviceAt.set("unclear", now);
      return this.say(
        unclear === "dark"
          ? "Stop. Too dark, the camera cannot see"
          : "Stop. The image is blurry. Wipe the camera or hold the phone steady",
        false,
        now,
      );
    }

    // 4. Совет обхода: то, что показано на экране, должно прозвучать. Для препятствия на пути
    //    говорим сторону, если для него ещё не говорили или сторона сменилась.
    if (p && !standing && !turning && p.in_path && !p.moving && p.distance <= STATIC_ANNOUNCE_M && (bypass === "left" || bypass === "right")) {
      const k = keyOf(p);
      const fresh = this.guide.key !== k || this.guide.bypass !== bypass;
      // Для того же препятствия сторону меняем редко: "left… right… left" только сбивает
      const wait = this.guide.key === k ? GUIDE_FLIP_MS : GUIDE_SIDE_MS;
      if (fresh && now - this.guide.at > wait) {
        this.guide = { bypass, at: now, key: k };
        this.primaryKey = k;
        this.primaryPhraseAt = now;
        return this.say(`${classLabel(p.cls)}, ${dist(p)}. ${passText(bypass)}`, false, now, false, true);
      }
    }

    // Стоит перед препятствием — совет, как обойти (сигнал в это время редкий и тихий)
    if (p && standing && settled && p.in_path && !p.moving && p.distance <= STATIC_ANNOUNCE_M) {
      const b: Bypass = bypass ?? "none";
      const wait = b !== this.guide.bypass ? GUIDE_CHANGE_MS : GUIDE_REPEAT_MS;
      if (now - this.guide.at > wait) {
        this.guide = { bypass: b, at: now, key: keyOf(p) };
        // Совет уже назвал препятствие — отдельно его не объявлять
        this.primaryKey = keyOf(p);
        this.primaryPhraseAt = now;
        if (b !== "none") return this.say(`${classLabel(p.cls)}, ${meters(p.distance)}. ${passText(b)}`, false, now);
        // Прохода в кадре нет — начинаем осмотр
        this.scan = { since: now, ref: h, minRel: 0, maxRel: 0, freeSince: null, promptAt: now, walking: 0 };
        return this.say(
          `${classLabel(p.cls)}, ${meters(p.distance)}. No way around. Turn the phone slowly left or right`,
          false,
          now,
        );
      }
    }

    // 5. Курс: обошёл препятствие и ушёл в сторону — вернуть, с числом градусов.
    //    Пока препятствие на пути рядом, молчим: сначала обход, потом курс.
    const dev = input.course ?? null;
    if (dev == null) {
      this.courseOffSince = null;
      this.courseWasOff = false;
    } else if (turning) {
      this.courseOffSince = null; // крутит телефон — отклонение не настоящее
    } else if (Math.abs(dev) > COURSE_OFF_DEG) {
      this.courseOffSince ??= now;
      const busy = p != null && p.in_path && p.distance <= COURSE_BUSY_M;
      if (!busy && now - this.courseOffSince > COURSE_HOLD_MS && now - this.courseSaidAt > COURSE_REPEAT_MS) {
        this.courseSaidAt = now;
        this.courseWasOff = true;
        return this.say(courseText(dev), false, now);
      }
    } else {
      this.courseOffSince = null;
      if (this.courseWasOff && Math.abs(dev) < COURSE_ON_DEG) {
        this.courseWasOff = false;
        this.courseSaidAt = now;
        return this.say("On course", false, now);
      }
    }

    // 6. Заранее о живом и движущемся — не чаще одной такой фразы в 3 с
    if (now - this.lastEndAt < MINOR_GAP_MS) return null;

    const crowdGroup = groups.find((g) => g.type === "crowd");
    const parking = groups.some((g) => g.type === "parking");
    for (const g of groups) {
      if (g.type === "cluster") continue;
      if (g.type === "crowd" && g.distance > DYNAMIC_ANNOUNCE_M) continue; // группа людей — тоже с 10 м
      const zones = g.zones.join(",");
      const prev = this.groupSaid.get(g.type);
      const repeat = g.type === "crowd" ? CROWD_REPEAT_MS : PARKING_REPEAT_MS;
      // Группа сместилась (была слева — теперь впереди) — говорим, но не чаще раза в 10 с
      const changed = g.type === "crowd" && prev != null && prev.zones !== zones && now - prev.at > CROWD_CHANGE_MS;
      if (!prev || changed || now - prev.at > repeat) {
        this.groupSaid.set(g.type, { zones, at: now });
        const again = prev != null && !changed;
        return this.say(again && g.type === "parking" ? "Still in the parking area, be careful" : groupText(g), false, now);
      }
    }
    for (const t of ["crowd", "parking"]) {
      // Группа пропала — следующий раз скажем сразу
      if (!groups.some((g) => g.type === t)) this.groupSaid.delete(t);
    }

    const notices = obstacles
      .filter((o) => o.kind !== "obstacle" && !o.primary)
      // едущий транспорт — как только сервер его подтвердил; люди и животные — с 10 м; стоящий транспорт — с 5 м
      .filter((o) =>
        o.kind === "vehicle"
          ? (o.moving && o.alert === "warn") || o.distance <= STATIC_ANNOUNCE_M
          : o.distance <= DYNAMIC_ANNOUNCE_M)
      .filter((o) => !(crowdGroup && o.kind === "person" && !o.moving)) // в группе — не по одному
      .filter((o) => !(parking && o.kind === "vehicle" && !o.moving)) // на парковке — стоящие машины не по одной
      // стоит или крутит телефон — только то, что само движется к тебе
      .filter((o) => !(turning || standing) || o.moving || (o.kind !== "vehicle" && o.own_speed > 0.5))
      .sort((a, b) => Number(b.moving) - Number(a.moving) || a.distance - b.distance);
    for (const o of notices) {
      const k = keyOf(o);
      if (now - (this.noticeAt.get(k) ?? -Infinity) < NOTICE_REPEAT_MS) continue;
      this.noticeAt.set(k, now);
      return this.say(noticeText(o), false, now);
    }
    if (this.noticeAt.size > 200) this.noticeAt.clear();

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
      this.standBlocked = false; // осмотр окончен — новый только после того, как снова встанет перед препятствием
      this.primaryKey = p ? keyOf(p) : null; // то, что сейчас в кадре, уже "известно" — не объявлять заново
      this.guide = { bypass: null, at: now };
      this.primaryPhraseAt = now; // после осмотра не объявлять сразу то, что мелькнуло в кадре
    };

    // Человек пошёл (препятствие быстро приближается) — обычный режим
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
      // Нашли свободное направление — сразу, перебивая "keep turning"
      end();
      if (rel == null) return this.say("Clear here. Go this way", false, now, true);
      if (Math.abs(rel) < SCAN_TURNED_DEG) return this.say("Path clear", false, now, true);
      const deg = Math.max(5, Math.round(Math.abs(rel) / 5) * 5);
      return this.say(`Clear, ${deg} degrees ${rel > 0 ? "right" : "left"}. Go this way`, false, now, true);
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
        return this.say("No way through. Try going back", false, now);
      }
      if (doneR) return this.say("Nothing on the right. Turn the phone left", false, now);
      if (doneL) return this.say("Nothing on the left. Turn the phone right", false, now);
    }
    return this.say("Keep turning", false, now);
  }

  /**
   * Камера смотрит в пол (или в небо) — по нарастающей:
   *   1-я просьба сразу; через 5 с — вторая; ещё через 15 с — "Stop…",
   *   и дальше "Stop…" каждые 15 с, пока телефон не поднимут.
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
      const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
      // Сначала голос, встроенный в телефон: сетевой начинает говорить с задержкой до секунды
      const local = en.filter((v) => v.localService);
      const pool = local.length ? local : en;
      this.voice = pool.find((v) => v.lang.toLowerCase().replace("_", "-") === "en-us") ?? pool[0] ?? null;
    };
    pickVoice();
    window.speechSynthesis.onvoiceschanged = pickVoice;
    const warm = new SpeechSynthesisUtterance("");
    warm.volume = 0;
    window.speechSynthesis.speak(warm);
  }

  private utter(text: string, rate: number) {
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = "en-US";
    if (this.voice) utt.voice = this.voice;
    utt.rate = rate;
    utt.volume = 1;
    return utt;
  }

  update(input: AnnouncerInput) {
    if (!this.supported || !this.enabled) return;
    const synth = window.speechSynthesis;
    const u = this.logic.pick(input, Date.now(), synth.speaking);
    if (!u) return;
    if (u.danger || u.interrupt) synth.cancel();
    const utt = this.utter(u.text, 1.3);
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
    synth.speak(this.utter(text, 1.1));
  }

  stop() {
    this.logic.reset();
    if (this.supported) window.speechSynthesis.cancel();
    this.onSpeakingChange?.(false);
  }
}

export const announcer = new Announcer();
