import { Platform } from "react-native";

/**
 * Стоит человек или идёт — по акселерометру телефона (devicemotion, ~60 раз в секунду).
 *
 * Каждый шаг даёт резкий толчок: модуль ускорения "прыгает" на 2–4 м/с² вокруг земного 9.8.
 * Телефон в руке стоящего человека дрожит слабо (< 1 м/с²), медленный поворот телефона —
 * тоже слабо. Поэтому:
 *   - толчок больше STEP_P2P за последние 0.5 с -> ИДЁТ (сразу, с первого шага);
 *   - STILL_MS подряд без толчков сильнее STILL_P2P -> СТОИТ.
 */

export type MotionState = "walking" | "still" | "unknown";

const STEP_P2P = 2.0; // м/с², размах ускорения от шага
const STILL_P2P = 1.0; // м/с², меньше — рука почти неподвижна
const STEP_WINDOW_MS = 500;
const STILL_MS = 1500;
const STALE_MS = 1000;

class MotionSensor {
  private samples: { t: number; a: number }[] = [];
  private state: MotionState = "unknown";
  private lastEventAt = 0;
  private listening = false;

  private onMotion = (e: DeviceMotionEvent) => {
    const g = e.accelerationIncludingGravity;
    if (!g || g.x == null || g.y == null || g.z == null) return;
    const now = Date.now();
    this.lastEventAt = now;
    this.samples.push({ t: now, a: Math.hypot(g.x, g.y, g.z) });
    while (this.samples.length && now - this.samples[0].t > STILL_MS) this.samples.shift();

    const p2p = (fromMs: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of this.samples) {
        if (now - s.t > fromMs) continue;
        lo = Math.min(lo, s.a);
        hi = Math.max(hi, s.a);
      }
      return hi - lo;
    };
    if (p2p(STEP_WINDOW_MS) > STEP_P2P) {
      this.state = "walking"; // шаг — сразу
    } else if (this.state !== "still" && this.samples[0] && now - this.samples[0].t >= STILL_MS * 0.9
               && p2p(STILL_MS) < STILL_P2P) {
      this.state = "still";
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

  current(now: number): MotionState {
    return now - this.lastEventAt > STALE_MS ? "unknown" : this.state;
  }
}

export const motionSensor = new MotionSensor();

// Запасной вариант без акселерометра (ноутбук, iPhone без разрешения):
// скорость пользователя, которую сервер оценивает по картинке. Медленнее и грубее.
const EGO_STILL_MPS = 0.15;
const EGO_MOVING_MPS = 0.35;
const EGO_STILL_MS = 2000;
let egoStill = false;
let egoQuietSince: number | null = null;

export function reportEgoSpeed(ego: number | null, now: number) {
  if (ego == null) return;
  if (Math.abs(ego) > EGO_MOVING_MPS) {
    egoStill = false;
    egoQuietSince = null;
  } else if (Math.abs(ego) < EGO_STILL_MPS) {
    egoQuietSince ??= now;
    if (now - egoQuietSince >= EGO_STILL_MS) egoStill = true;
  }
}

/** Человек стоит на месте: по акселерометру, а без него — по оценке сервера. */
export function isStill(now: number): boolean {
  const m = motionSensor.current(now);
  return m === "unknown" ? egoStill : m === "still";
}

export function resetStillness() {
  egoStill = false;
  egoQuietSince = null;
}
