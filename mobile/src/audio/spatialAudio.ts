import { Platform } from "react-native";
import type { Obstacle } from "../api/protocol";

/**
 * Звук — ПАРКТРОНИК, привязанный к камере.
 *
 * Сервер в каждом кадре мерит расстояние до ближайшего, что прямо перед камерой (полоса шириной
 * с человека), без подтверждений и выбора "главной угрозы" (поле front). Писк зависит только от него:
 * чем ближе — тем чаще, плавно (6 м — 0.92 с, 4 м — 0.58, 3 м — 0.39, 2 м — 0.21, 1.2 м — 0.08),
 * ближе 0.9 м — один непрерывный писк. Кадр без данных — держим последнее расстояние 0.5 с.
 * Писк не замолкает, когда человек стоит или говорит голос (под голосом — тише).
 *
 * СТОРОНА — стерео: писк в том ухе, где препятствие (угол растянут втрое: камера видит всего ±20°).
 * ОБХОД — препятствие сбоку рядом (по карте, в том числе уже вне кадра) тихо тикает в своё ухо.
 * Отдельно — тревога для того, что ЕДЕТ на тебя (двойной тон).
 */

const STALE_MS = 1200; // давно нет данных от сервера — замолкаем
const TICK_MS = 20;
const HOLD_MS = 600; // главная опасность мигнула — держим сигнал
const ALARM_INTERVAL_S = 0.9;
const DIRECTION_GAIN = 3; // 10° в кадре -> 30° в наушниках
const MASTER_GAIN = 1.25; // общая громкость сигналов
const DUCK_GAIN = 0.55; // пока говорит голос — писк тише, но не пропадает (иначе слышны одиночные пики)
// ПАРКТРОНИК: расстояние до ближайшего прямо перед камерой (сервер, каждый кадр, поле front).
// Интервал плавно сокращается с расстоянием; ближе SOLID_FRONT_M — один непрерывный писк.
const FRONT_FAR_M = 6.0; // дальше — тишина
const SOLID_FRONT_M = 0.9;
const FRONT_HOLD_MS = 500; // кадр без данных — держим последнее расстояние, ритм не рвётся
const FRONT_SMOOTH = 0.5; // сглаживание расстояния между кадрами (0..1, больше — быстрее)
/** Интервал между писками по расстоянию: 6 м — 0.92 с, 4 м — 0.58, 3 м — 0.39, 2 м — 0.21, 1.2 м — 0.08. */
export function frontInterval(d: number): number {
  if (d <= SOLID_FRONT_M) return 0;
  const t = Math.min(1, (d - SOLID_FRONT_M) / (FRONT_FAR_M - SOLID_FRONT_M));
  return 0.07 + 0.85 * Math.pow(t, 1.3);
}
// Ступени: [до скольких метров, интервал с]; ближе SOLID_M — сплошной тон
const SOLID_M = 1.0;
const STEPS: [number, number][] = [
  [1.5, 0.17],
  [2.0, 0.26],
  [2.5, 0.34],
  [3.0, 0.44],
  [3.5, 0.56],
  [4.0, 0.7],
  [6.0, 1.0],
];
const HYST_M = 0.15;
// Обход: препятствие сбоку рядом
const SIDE_FAR_M = 1.2;
const SIDE_LEVEL = 0.35;
const SIDE_FREQ = 1500;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const TONE: Record<Obstacle["kind"], { freq: number; type: OscillatorType }> = {
  obstacle: { freq: 950, type: "square" },
  person: { freq: 1250, type: "triangle" },
  animal: { freq: 1250, type: "triangle" },
  vehicle: { freq: 800, type: "sawtooth" },
};

/** Номер ступени по расстоянию: 0 — сплошной тон, 1..STEPS.length, STEPS.length+1 — дальше 6 м (тишина). */
function stepOf(d: number): number {
  if (d <= SOLID_M) return 0;
  const i = STEPS.findIndex(([max]) => d <= max);
  return i < 0 ? STEPS.length + 1 : i + 1;
}

/** Интервал между сигналами (с) для препятствия; 0 — сплошной тон. Для вибрации/экрана. */
export function beepInterval(o: Obstacle): number {
  const s = stepOf(o.distance);
  return s === 0 ? 0 : s > STEPS.length ? 1.0 : STEPS[s - 1][1];
}

class SpatialAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private pan: StereoPannerNode | null = null; // главная опасность
  private alarmPan: StereoPannerNode | null = null; // едущее на тебя (если не главное)
  private sidePan: StereoPannerNode | null = null; // препятствие сбоку при обходе
  private primary: Obstacle | null = null;
  private front: { d: number; bearing: number } | null = null; // парктроник
  private frontAt = 0;
  private primaryAt = 0;
  private primaryKey: string | null = null;
  private step = STEPS.length + 1;
  private alarm: Obstacle | null = null;
  private near: { left: number | null; right: number | null } = { left: null, right: null };
  private nextBeep = 0;
  private lastBeep = 0;
  private nextAlarm = 0;
  private nextSide = 0;
  private sideTurn = 0; // по очереди левое / правое, если рядом с обеих сторон
  private solid: { osc: OscillatorNode; gain: GainNode } | null = null;
  private lastUpdate = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private calmSince: number | null = null;
  private calmDist = 0;
  /** Человек стоит перед препятствием (по картинке): сигнал редкий и тихий. */
  calm = false;
  /** Осмотр: человек стоит и поворачивает телефон в поисках прохода — сигнал тихий. */
  scan = false;
  /** Стоит (по акселерометру): сигнал о неподвижном препятствии редкий и тихий, не выключается. */
  standing = false;
  private wasStanding = false;
  enabled = true;

  get supported() {
    return Platform.OS === "web" && typeof window !== "undefined" && "AudioContext" in window;
  }

  /** Вызывать из обработчика нажатия: браузеры разрешают звук только после жеста. */
  unlock() {
    if (!this.supported) return;
    if (!this.ctx) this.init();
    void this.ctx!.resume();
  }

  private init() {
    const ctx = new AudioContext();
    // Компрессор поднимает громкость коротких сигналов и не даёт им клиппировать
    const comp = new DynamicsCompressorNode(ctx, { threshold: -24, knee: 6, ratio: 8, attack: 0.002, release: 0.1 });
    const master = ctx.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(comp).connect(ctx.destination);
    const mkPan = () => {
      const p = new StereoPannerNode(ctx, { pan: 0 });
      p.connect(master);
      return p;
    };
    this.ctx = ctx;
    this.master = master;
    this.pan = mkPan();
    this.alarmPan = mkPan();
    this.sidePan = mkPan();
  }

  /** Угол на объект -> стерео: -1 — только левое ухо, +1 — только правое. */
  private place(pan: StereoPannerNode, bearingDeg: number) {
    const v = Math.sin((clamp(bearingDeg * DIRECTION_GAIN, -90, 90) * Math.PI) / 180);
    pan.pan.setTargetAtTime(v, this.ctx!.currentTime, 0.03);
  }

  /** Новые данные от сервера. near — ближайшее препятствие слева/справа рядом (по карте). */
  update(obstacles: Obstacle[], near?: { left: number | null; right: number | null } | null,
         front?: { d: number; bearing: number } | null) {
    const now = Date.now();
    this.lastUpdate = now;
    if (front) {
      // сглаживаем, но приближение принимаем быстрее (безопаснее)
      const prev = this.front;
      const a = prev && front.d < prev.d ? Math.max(FRONT_SMOOTH, 0.7) : FRONT_SMOOTH;
      this.front = prev ? { d: prev.d + a * (front.d - prev.d), bearing: front.bearing } : { ...front };
      this.frontAt = now;
      if (this.ctx) this.place(this.pan!, front.bearing);
    } else if (now - this.frontAt > FRONT_HOLD_MS) {
      this.front = null;
    }
    this.near = near ?? { left: null, right: null };
    this.alarm = obstacles.find((o) => o.moving && o.threat && !o.primary) ?? null;
    const p = obstacles.find((o) => o.primary) ?? null;
    if (p) {
      const key = `${p.kind}:${p.id}`;
      if (key !== this.primaryKey) {
        this.nextBeep = 0; // новая главная опасность — первый сигнал сразу
        this.step = stepOf(p.distance);
      } else {
        // Ступень меняется только с запасом: ритм не прыгает от шума расстояния
        // ближе — принимаем, если и с запасом 0.15 м уже ближе; дальше — если и с запасом дальше
        const s = stepOf(p.distance);
        if (s < this.step && stepOf(p.distance + HYST_M) < this.step) this.step = s;
        else if (s > this.step && stepOf(p.distance - HYST_M) > this.step) this.step = s;
      }
      this.updateCalm(p, key === this.primaryKey);
      this.primary = p;
      this.primaryKey = key;
      this.primaryAt = now;
    } else if (now - this.primaryAt > HOLD_MS) {
      this.primary = null; // пропала не на миг — отпускаем
      this.primaryKey = null;
      this.calm = false;
      this.calmSince = null;
    }
    if (!this.ctx) return;
    if (this.primary) this.place(this.pan!, this.primary.bearing);
    if (this.alarm) this.place(this.alarmPan!, this.alarm.bearing);
  }

  /** Стоит ли человек (по картинке): главная опасность неподвижна и не приближается 2 с. */
  private updateCalm(p: Obstacle, same: boolean) {
    const now = Date.now();
    const stays = !p.moving && same && Math.abs(p.approach) < 0.2 && (this.calmSince == null || p.distance > this.calmDist - 0.3);
    if (!stays) {
      if (this.calm) this.nextBeep = 0; // пошёл — обычный сигнал сразу
      this.calm = false;
      this.calmSince = null;
      return;
    }
    if (this.calmSince == null) {
      this.calmSince = now;
      this.calmDist = p.distance;
    } else if (now - this.calmSince >= 2000) {
      this.calm = true;
    }
  }

  /** Приглушить сигналы, пока говорит голос (но не до тишины — опасность важнее). */
  duck(on: boolean) {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(on ? DUCK_GAIN : MASTER_GAIN, this.ctx.currentTime, 0.04);
  }

  start() {
    if (!this.supported || this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.primary = this.alarm = null;
    this.front = null;
    this.primaryKey = null;
    this.calm = false;
    this.calmSince = null;
    this.stopSolid();
  }

  private tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const fresh = Date.now() - this.lastUpdate < STALE_MS;
    const p = fresh && this.enabled ? this.primary : null;
    const now = ctx.currentTime;

    // Парктроник: чем ближе то, что прямо перед камерой, тем чаще; вплотную — непрерывно
    const f = fresh && this.enabled ? this.front : null;
    const iv = f && f.d <= FRONT_FAR_M ? frontInterval(f.d) : null;
    if (iv === 0) {
      this.startSolid(TONE.obstacle);
    } else {
      this.stopSolid();
      if (iv != null) {
        // интервал меняется с расстоянием сразу, не дожидаясь старого (иначе ритм "запаздывает")
        this.nextBeep = Math.min(this.nextBeep, this.lastBeep + iv);
        if (now >= this.nextBeep) {
          this.beep(this.pan!, TONE.obstacle, 1.0);
          this.lastBeep = now;
          this.nextBeep = now + iv;
        }
      } else {
        this.nextBeep = 0; // появилось препятствие — первый писк сразу
      }
    }
    void p;

    // Обход: препятствие сбоку рядом — тихий тик в своё ухо (не пока стоит: это раздражает)
    if (fresh && this.enabled && this.solid == null && now >= this.nextSide) {
      const { left, right } = this.near;
      const sides = ([["left", left], ["right", right]] as const).filter(([, d]) => d != null && d <= SIDE_FAR_M);
      if (sides.length) {
        const [side, d] = sides[this.sideTurn++ % sides.length];
        this.sidePan!.pan.value = side === "left" ? -0.95 : 0.95;
        this.beep(this.sidePan!, { freq: SIDE_FREQ, type: "sine" }, SIDE_LEVEL, 0.05);
        this.nextSide = now + clamp(0.25 + (d as number) * 0.35, 0.3, 0.7);
      }
    }

    const a = fresh && this.enabled ? this.alarm : null;
    if (a && now >= this.nextAlarm) {
      this.chirp(this.alarmPan!);
      this.nextAlarm = now + ALARM_INTERVAL_S;
    }
  }

  private beep(dest: AudioNode, tone: { freq: number; type: OscillatorType }, level: number, dur = 0.08) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const osc = new OscillatorNode(ctx, { type: tone.type, frequency: tone.freq });
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(level, t + 0.005);
    env.gain.setValueAtTime(level, t + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Тревога "едет на тебя": два быстрых тона вверх-вниз. */
  private chirp(dest: AudioNode) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const osc = new OscillatorNode(ctx, { type: "square", frequency: 1400 });
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.setValueAtTime(1000, t + 0.09);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.8, t + 0.005);
    env.gain.setValueAtTime(0.8, t + 0.16);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    osc.connect(env).connect(dest);
    osc.start(t);
    osc.stop(t + 0.21);
  }

  private startSolid(tone: { freq: number; type: OscillatorType }) {
    if (this.solid) return;
    const ctx = this.ctx!;
    const osc = new OscillatorNode(ctx, { type: "square", frequency: tone.freq * 1.2 });
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.02);
    osc.connect(gain).connect(this.pan!);
    osc.start();
    this.solid = { osc, gain };
  }

  private stopSolid() {
    if (!this.solid || !this.ctx) return;
    const { osc, gain } = this.solid;
    const t = this.ctx.currentTime;
    gain.gain.setTargetAtTime(0.0001, t, 0.015);
    osc.stop(t + 0.1);
    this.solid = null;
  }
}

export const spatialAudio = new SpatialAudio();
