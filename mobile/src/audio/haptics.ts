import { Platform } from "react-native";
import type { Obstacle } from "../api/protocol";
import { beepInterval } from "./spatialAudio";

/**
 * Вибрация (Vibration API браузера — работает в Chrome на Android; iPhone её не поддерживает).
 *
 *   - Препятствие ПРЯМО НА ПУТИ ближе 2 м (или меньше 2 с до него) — импульсы
 *     в такт звуку, чем ближе, тем чаще; вплотную — непрерывно ("стоп").
 *   - Что-то едет на тебя — двойной толчок (не чаще раза в 4 с).
 */

const START_DIST_M = 2.0;
const START_TTC_S = 2.0;
const PULSE_MS = 70;
const SOLID_CHUNK_MS = 500; // непрерывная вибрация — кусками, продлеваем каждый тик
const DANGER_PATTERN = [150, 80, 150];
const DANGER_COOLDOWN_MS = 4000;
const STALE_MS = 1200;
const TICK_MS = 50;

class Haptics {
  enabled = true;
  private primary: Obstacle | null = null;
  private danger: Obstacle | null = null;
  private lastUpdate = 0;
  private nextPulse = 0;
  private solidUntil = 0;
  private dangerAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Человек стоит — вибрация о неподвижном препятствии молчит (как и звук). */
  isQuiet: () => boolean = () => false;

  get supported() {
    return Platform.OS === "web" && typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
  }

  update(obstacles: Obstacle[]) {
    this.lastUpdate = Date.now();
    this.primary = obstacles.find((o) => o.primary && o.in_path) ?? null;
    this.danger = obstacles.find((o) => o.moving && o.threat) ?? null;
  }

  start() {
    if (!this.supported || this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.primary = this.danger = null;
    this.dangerAt.clear();
    if (this.supported) navigator.vibrate(0);
  }

  private tick() {
    const now = Date.now();
    if (!this.enabled || now - this.lastUpdate > STALE_MS) {
      if (this.solidUntil > now) navigator.vibrate(0);
      this.solidUntil = 0;
      return;
    }

    const d = this.danger;
    if (d) {
      const k = `${d.kind}:${d.id}`;
      if (now - (this.dangerAt.get(k) ?? -Infinity) > DANGER_COOLDOWN_MS) {
        this.dangerAt.set(k, now);
        navigator.vibrate(DANGER_PATTERN);
        this.nextPulse = now + 500;
        return;
      }
    }

    const p = this.isQuiet() && !this.primary?.moving ? null : this.primary;
    const close = p && (p.distance <= START_DIST_M || (p.ttc != null && p.ttc <= START_TTC_S));
    if (!p || !close) {
      if (this.solidUntil > now) navigator.vibrate(0);
      this.solidUntil = 0;
      return;
    }
    const interval = beepInterval(p);
    if (interval === 0) {
      // Вплотную: непрерывно, продлеваем до того, как кусок закончится
      if (this.solidUntil - now < TICK_MS * 2) {
        navigator.vibrate(SOLID_CHUNK_MS);
        this.solidUntil = now + SOLID_CHUNK_MS;
      }
      return;
    }
    if (this.solidUntil > now) {
      navigator.vibrate(0);
      this.solidUntil = 0;
    }
    if (now >= this.nextPulse) {
      navigator.vibrate(PULSE_MS);
      this.nextPulse = now + Math.max(200, interval * 1000);
    }
  }
}

export const haptics = new Haptics();
