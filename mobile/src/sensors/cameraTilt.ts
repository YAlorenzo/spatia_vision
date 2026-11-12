import { Platform } from "react-native";

/**
 * Куда смотрит камера по вертикали — по датчику ориентации телефона.
 *
 * Угол камеры над горизонтом: 0° — прямо вперёд, −90° — в пол, +90° — в небо.
 * Из углов deviceorientation (beta — наклон вперёд-назад, gamma — вбок):
 *   elevation = asin(−cos(beta)·cos(gamma))
 * Формула не зависит от того, вертикально или горизонтально держат телефон.
 *
 * Совет даётся, только если неправильный наклон держится больше SUSTAIN_MS
 * (короткие взмахи рукой при ходьбе не считаются).
 */

export type TiltAdvice = "raise" | "lower";

const TOO_LOW_DEG = -40; // ниже — камера смотрит под ноги и не видит препятствий впереди
const TOO_HIGH_DEG = 25; // выше — смотрит в небо/потолок, пол не виден
const SUSTAIN_MS = 1500;

class CameraTilt {
  elevation: number | null = null; // градусы; null — датчика нет
  private badSince: number | null = null;
  private badKind: TiltAdvice | null = null;
  private listening = false;

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    const rad = Math.PI / 180;
    const s = -Math.cos(e.beta * rad) * Math.cos(e.gamma * rad);
    const e2 = Math.asin(Math.max(-1, Math.min(1, s))) / rad;
    this.elevation = e2;
    const kind: TiltAdvice | null = e2 < TOO_LOW_DEG ? "raise" : e2 > TOO_HIGH_DEG ? "lower" : null;
    if (kind !== this.badKind) {
      this.badKind = kind;
      this.badSince = kind ? Date.now() : null;
    }
  };

  /** Вызывать из обработчика нажатия: iOS спрашивает разрешение только по жесту. */
  unlock() {
    if (Platform.OS !== "web" || typeof window === "undefined" || !("DeviceOrientationEvent" in window)) return;
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    const listen = () => {
      if (this.listening) return;
      window.addEventListener("deviceorientation", this.onOrientation);
      this.listening = true;
    };
    if (typeof DOE.requestPermission === "function") {
      DOE.requestPermission()
        .then((r) => r === "granted" && listen())
        .catch(() => {});
    } else {
      listen();
    }
  }

  /** Совет по наклону, если плохой наклон держится долго; иначе null. */
  advice(now: number): TiltAdvice | null {
    return this.badKind && this.badSince != null && now - this.badSince >= SUSTAIN_MS ? this.badKind : null;
  }
}

export const cameraTilt = new CameraTilt();
