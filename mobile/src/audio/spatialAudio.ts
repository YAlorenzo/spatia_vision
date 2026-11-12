import { Platform } from "react-native";
import type { Obstacle } from "../api/protocol";

/**
 * Пространственный звук: ОДНА главная опасность, всё остальное молчит.
 *
 * Главную опасность выбирает сервер (поле primary): то, во что врежешься, если идти
 * прямо, или то, что едет на тебя. О ней — громкий сигнал "как парктроник":
 *   - чем меньше время до столкновения, тем чаще сигнал; вплотную — непрерывный тон ("стоп");
 *   - звук идёт с той стороны, где опасность (HRTF, лучше всего в наушниках);
 *   - тембр: препятствие — ровный тон, человек — выше, транспорт — резкий.
 * Отдельно — тревога для того, что ЕДЕТ на тебя, если оно не главная опасность.
 * Частоты 900–1800 Гц: динамик телефона плохо воспроизводит низкие, они звучат тихо.
 * Работает в вебе (Web Audio API).
 */

const STALE_MS = 1200; // давно нет данных от сервера — замолкаем
const TICK_MS = 20;
const SLOW_TTC_S = 7; // при таком времени до столкновения — самые редкие сигналы
const SOLID_TTC_S = 0.9; // ближе — непрерывный тон
const SOLID_DIST_M = 0.8;
const ALARM_INTERVAL_S = 0.9;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const TONE: Record<Obstacle["kind"], { freq: number; type: OscillatorType }> = {
  obstacle: { freq: 950, type: "square" },
  person: { freq: 1250, type: "triangle" },
  animal: { freq: 1250, type: "triangle" },
  vehicle: { freq: 800, type: "sawtooth" },
};

/** Интервал между сигналами (с) по времени до столкновения; 0 — непрерывный тон. */
export function beepInterval(o: Obstacle): number {
  const ttc = o.ttc ?? SLOW_TTC_S;
  if (ttc <= SOLID_TTC_S || o.distance <= SOLID_DIST_M) return 0;
  // Квадратичная шкала: заметно учащается именно вблизи
  const t = clamp((ttc - SOLID_TTC_S) / (SLOW_TTC_S - SOLID_TTC_S), 0, 1);
  return 0.09 + 0.8 * t * t;
}

class SpatialAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private panner: PannerNode | null = null; // главная опасность
  private alarmPanner: PannerNode | null = null; // едущее на тебя (если не главное)
  private primary: Obstacle | null = null;
  private alarm: Obstacle | null = null;
  private nextBeep = 0;
  private nextAlarm = 0;
  private solid: { osc: OscillatorNode; gain: GainNode } | null = null;
  private lastUpdate = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
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
    master.gain.value = 1.6;
    master.connect(comp).connect(ctx.destination);
    const mkPanner = () => {
      const p = new PannerNode(ctx, {
        panningModel: "HRTF",
        distanceModel: "linear",
        rolloffFactor: 0, // громкость задаём сами
        positionX: 0,
        positionY: 0,
        positionZ: -1,
      });
      p.connect(master);
      return p;
    };
    this.ctx = ctx;
    this.master = master;
    this.panner = mkPanner();
    this.alarmPanner = mkPanner();
  }

  private place(panner: PannerNode, bearingDeg: number) {
    const az = (clamp(bearingDeg, -80, 80) * Math.PI) / 180;
    const now = this.ctx!.currentTime;
    panner.positionX.setTargetAtTime(Math.sin(az), now, 0.03);
    panner.positionZ.setTargetAtTime(-Math.cos(az), now, 0.03);
  }

  /** Новые данные от сервера. */
  update(obstacles: Obstacle[]) {
    this.lastUpdate = Date.now();
    const prevKey = this.primary ? `${this.primary.kind}:${this.primary.id}` : null;
    this.primary = obstacles.find((o) => o.primary) ?? null;
    this.alarm = obstacles.find((o) => o.moving && o.threat && !o.primary) ?? null;
    if (!this.ctx) return;
    if (this.primary) {
      this.place(this.panner!, this.primary.bearing);
      // Новая главная опасность — первый сигнал сразу, не ждём интервала старой
      if (`${this.primary.kind}:${this.primary.id}` !== prevKey) this.nextBeep = 0;
    }
    if (this.alarm) this.place(this.alarmPanner!, this.alarm.bearing);
  }

  /** Приглушить сигналы, пока говорит голос (но не до тишины — опасность важнее). */
  duck(on: boolean) {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(on ? 0.6 : 1.6, this.ctx.currentTime, 0.04);
  }

  start() {
    if (!this.supported || this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.primary = this.alarm = null;
    this.stopSolid();
  }

  private tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const fresh = Date.now() - this.lastUpdate < STALE_MS;
    const p = fresh && this.enabled ? this.primary : null;
    const now = ctx.currentTime;

    if (p && beepInterval(p) === 0) {
      this.startSolid(p);
    } else {
      this.stopSolid();
      if (p && now >= this.nextBeep) {
        this.beep(this.panner!, p, 1.0);
        this.nextBeep = now + beepInterval(p);
      }
    }

    const a = fresh && this.enabled ? this.alarm : null;
    if (a && now >= this.nextAlarm) {
      this.chirp(this.alarmPanner!);
      this.nextAlarm = now + ALARM_INTERVAL_S;
    }
  }

  private beep(dest: AudioNode, o: Obstacle, level: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const tone = TONE[o.kind];
    const dur = 0.08;
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

  private startSolid(o: Obstacle) {
    if (this.solid) return;
    const ctx = this.ctx!;
    const osc = new OscillatorNode(ctx, { type: "square", frequency: TONE[o.kind].freq * 1.2 });
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.9, ctx.currentTime + 0.02);
    osc.connect(gain).connect(this.panner!);
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
