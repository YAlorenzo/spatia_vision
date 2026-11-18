import { Platform } from "react-native";
import { cameraTilt } from "./cameraTilt";

/**
 * Что делает человек: идёт, стоит, поворачивается — по датчикам телефона (не по картинке).
 *
 *   ИДЁТ / СТОИТ — акселерометр (devicemotion). Каждый шаг "встряхивает" телефон: разброс модуля
 *     ускорения за последнюю секунду при ходьбе ~1–3 м/с², у стоящего с телефоном в руке — ~0.1–0.3.
 *     Между порогами — состояние не меняется (гистерезис), чтобы не мигало.
 *   ПОВОРАЧИВАЕТСЯ — скорость поворота камеры по горизонтали (компас телефона), больше 25°/с.
 *     Остановился — поворот закончен через 0.5 с.
 *
 * ВАЖНО: это состояние меняет только то, что говорит голос. Сигнал опасности и тревога "едет на
 * тебя" от него не зависят: ошибся датчик — человек всё равно услышит препятствие.
 * Нет датчика — "unknown", голос работает как раньше.
 */

export type Gait = "walking" | "standing" | "unknown";

const WINDOW_MS = 1200;
const WALK_STD = 0.7; // м/с²: больше — идёт
const STAND_STD = 0.35; // меньше — стоит
const STAND_HOLD_MS = 800; // "стоит" — только если тихо столько подряд (не пауза между шагами)
const TURN_DPS = 25; // градусов в секунду: быстрее — поворачивается
const TURN_SETTLE_MS = 500; // поворот закончен, если медленно столько
const STALE_MS = 1000;

const norm = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

class Motion {
  private samples: { t: number; a: number }[] = [];
  private gait: Gait = "unknown";
  private quietSince: number | null = null;
  private lastMotionAt = 0;
  private listening = false;
  private headings: { t: number; h: number }[] = [];
  private turningUntil = 0;
  private rate = 0; // градусы в секунду, со знаком (> 0 — вправо)

  private onMotion = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null || g.z == null) return;
    const now = Date.now();
    this.lastMotionAt = now;
    this.samples.push({ t: now, a: Math.hypot(g.x, g.y, g.z) });
    while (this.samples.length && now - this.samples[0].t > WINDOW_MS) this.samples.shift();
    if (this.samples.length < 10) return;
    const mean = this.samples.reduce((s, x) => s + x.a, 0) / this.samples.length;
    const std = Math.sqrt(this.samples.reduce((s, x) => s + (x.a - mean) ** 2, 0) / this.samples.length);
    if (std > WALK_STD) {
      this.gait = "walking";
      this.quietSince = null;
    } else if (std < STAND_STD) {
      this.quietSince ??= now;
      if (now - this.quietSince >= STAND_HOLD_MS) this.gait = "standing";
    } else {
      this.quietSince = null;
    }
  };

  /** Вызывать из обработчика нажатия: iOS спрашивает разрешение только по жесту. */
  unlock() {
    if (Platform.OS !== "web" || typeof window === "undefined" || !("DeviceMotionEvent" in window)) return;
    const DME = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    const listen = () => {
      if (this.listening) return;
      window.addEventListener("devicemotion", this.onMotion);
      this.listening = true;
    };
    if (typeof DME.requestPermission === "function") {
      DME.requestPermission()
        .then((r) => r === "granted" && listen())
        .catch(() => {});
    } else {
      listen();
    }
  }

  /** Обновить поворот по компасу — вызывать часто (на каждом ответе сервера и в таймере). */
  private updateTurn(now: number) {
    const h = cameraTilt.heading(now);
    if (h == null) return;
    this.headings.push({ t: now, h });
    while (this.headings.length > 2 && now - this.headings[0].t > 400) this.headings.shift();
    const first = this.headings[0];
    const dt = (now - first.t) / 1000;
    if (dt < 0.15) return;
    this.rate = norm(h - first.h) / dt;
    if (Math.abs(this.rate) > TURN_DPS) this.turningUntil = now + TURN_SETTLE_MS;
  }

  walking(now: number): Gait {
    return now - this.lastMotionAt > STALE_MS ? "unknown" : this.gait;
  }

  /** Поворачивается прямо сейчас (или только что, < 0.5 с назад). */
  turning(now: number): boolean {
    this.updateTurn(now);
    return now < this.turningUntil;
  }

  /** Скорость поворота, °/с (> 0 — вправо). */
  turnRate(): number {
    return this.rate;
  }
}

export const motion = new Motion();

/** Короткая подпись для экрана и записи. */
export function motionLabel(now: number): "walking" | "standing" | "turning" | "unknown" {
  if (motion.turning(now)) return "turning";
  return motion.walking(now);
}
