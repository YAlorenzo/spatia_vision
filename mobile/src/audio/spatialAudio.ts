import { Platform } from "react-native";
import type { Kind, Obstacle, Zone } from "../api/protocol";

/**
 * Пространственный звук "как парктроник".
 *
 * В каждой зоне (слева / прямо / справа) свой источник звука, размещённый в 3D
 * через HRTF — в наушниках звук слышно с нужной стороны. Озвучивается
 * ближайшее препятствие зоны:
 *   - чем ближе (или чем меньше время до столкновения) — тем чаще и выше сигнал;
 *   - тембр зависит от типа: препятствие / человек / транспорт;
 *   - громкость — от срочности, боковые зоны чуть тише центральной.
 * Работает только в вебе (Web Audio API).
 */

const ZONES: Zone[] = ["left", "center", "right"];
const BEEP_MAX_M = 4.5; // дальше — тишина (не засоряем эфир)
const TTC_MAX_S = 6;
const STALE_MS = 1200; // давно нет данных от сервера — замолкаем
const TICK_MS = 25;
const HALF_FOV_DEG = 35; // pan ±1 -> ±35° по горизонтали

const VOICE: Record<Kind, { freq: number; type: OscillatorType }> = {
  obstacle: { freq: 520, type: "sine" },
  person: { freq: 760, type: "triangle" },
  animal: { freq: 760, type: "triangle" },
  vehicle: { freq: 340, type: "sawtooth" },
};

const URGENCY_GAIN = { high: 0.9, medium: 0.6, low: 0.35 } as const;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

/** Интервал между сигналами, с: 0.12 вплотную … 1.0 на краю зоны слышимости. */
export function beepInterval(o: Obstacle): number | null {
  const byDist = o.distance <= BEEP_MAX_M ? lerp(0.12, 1.0, (o.distance - 0.7) / (BEEP_MAX_M - 0.7)) : Infinity;
  const byTtc = o.ttc !== null && o.ttc <= TTC_MAX_S ? lerp(0.12, 1.0, (o.ttc - 1) / (TTC_MAX_S - 1)) : Infinity;
  const interval = Math.min(byDist, byTtc);
  return Number.isFinite(interval) ? interval : null;
}

interface ZoneVoice {
  panner: PannerNode;
  next: number; // время следующего сигнала (ctx.currentTime)
}

class SpatialAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<Zone, ZoneVoice>();
  private targets = new Map<Zone, Obstacle>();
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
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    for (const zone of ZONES) {
      const az = ((zone === "left" ? -1 : zone === "right" ? 1 : 0) * HALF_FOV_DEG * Math.PI) / 180;
      const panner = new PannerNode(ctx, {
        panningModel: "HRTF",
        distanceModel: "linear",
        rolloffFactor: 0, // громкость задаём сами
        positionX: Math.sin(az),
        positionY: 0,
        positionZ: -Math.cos(az),
      });
      panner.connect(master);
      this.voices.set(zone, { panner, next: 0 });
    }
    this.ctx = ctx;
    this.master = master;
  }

  /** Новые данные от сервера: выбираем ближайшее (самое срочное) препятствие в каждой зоне. */
  update(obstacles: Obstacle[]) {
    this.lastUpdate = Date.now();
    this.targets.clear();
    for (const o of obstacles) {
      const cur = this.targets.get(o.zone);
      const io = beepInterval(o);
      if (io === null) continue;
      const ic = cur ? beepInterval(cur) : null;
      if (ic === null || io < ic) this.targets.set(o.zone, o);
    }
    // Точное положение в зоне — по pan объекта
    if (this.ctx) {
      for (const [zone, o] of this.targets) {
        const v = this.voices.get(zone)!;
        const az = (clamp(o.pan, -1, 1) * HALF_FOV_DEG * Math.PI) / 180;
        v.panner.positionX.setTargetAtTime(Math.sin(az), this.ctx.currentTime, 0.05);
        v.panner.positionZ.setTargetAtTime(-Math.cos(az), this.ctx.currentTime, 0.05);
      }
    }
  }

  /** Приглушить сигналы, пока говорит голос. */
  duck(on: boolean) {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(on ? 0.25 : 0.8, this.ctx.currentTime, 0.05);
  }

  start() {
    if (!this.supported || this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.targets.clear();
  }

  private tick() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || !this.enabled) return;
    if (Date.now() - this.lastUpdate > STALE_MS) return;
    const now = ctx.currentTime;
    for (const [zone, o] of this.targets) {
      const v = this.voices.get(zone)!;
      if (now < v.next) continue;
      const interval = beepInterval(o);
      if (interval === null) continue;
      this.beep(v.panner, o);
      v.next = now + interval;
    }
  }

  private beep(dest: AudioNode, o: Obstacle) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.01;
    const voice = VOICE[o.kind];
    // Ближе — выше тон (до +60%)
    const freq = voice.freq * (1 + 0.6 * clamp(1 - o.distance / BEEP_MAX_M, 0, 1));
    const gain = URGENCY_GAIN[o.urgency] * (o.zone === "center" ? 1 : 0.75) * (voice.type === "sawtooth" ? 0.5 : 1);
    const dur = o.kind === "vehicle" ? 0.12 : 0.07;

    const osc = ctx.createOscillator();
    osc.type = voice.type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

export const spatialAudio = new SpatialAudio();
