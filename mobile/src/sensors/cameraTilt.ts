import { Platform } from "react-native";

/**
 * Ориентация телефона по датчику (deviceorientation): куда "вверх" относительно камеры.
 *
 * 1. Направление "вверх" (против гравитации) в координатах КАМЕРЫ — уходит на сервер
 *    с каждым кадром. Сервер по нему считает "вперёд/вбок" в земных осях, поэтому
 *    телефон не обязательно держать строго вертикально: наклон вперёд-назад и завал
 *    вбок учитываются.
 *    Из углов beta (наклон вперёд-назад) и gamma (вбок) "вверх" в осях устройства:
 *      u = (−cos β·sin γ, sin β, cos β·cos γ)   (x — вправо, y — к верху телефона, z — из экрана)
 *    Оси камеры: x вправо по картинке, y вниз по картинке, z — от задней камеры вперёд;
 *    картинка повёрнута вместе с экраном (screen.orientation.angle).
 *
 * 2. Угол камеры над горизонтом (0° — прямо, −90° — в пол) — для совета "поднимите телефон".
 *    Совет — только если плохой наклон держится больше SUSTAIN_MS (взмахи рукой не считаются).
 */

export type TiltAdvice = "raise" | "lower";
export type Vec3 = [number, number, number];

// Наклон до −50° сервер уже учитывает сам; ниже — камера видит только асфальт под ногами
const TOO_LOW_DEG = -50;
const TOO_HIGH_DEG = 30; // выше — смотрит в небо/потолок, пол не виден
const SUSTAIN_MS = 2000;
const STALE_MS = 1000; // датчик молчит дольше — данных нет

const rad = Math.PI / 180;

function screenAngle(): number {
  if (typeof window === "undefined") return 0;
  const a = window.screen?.orientation?.angle;
  if (typeof a === "number") return a;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

class CameraTilt {
  elevation: number | null = null; // градусы; null — датчика нет
  private up: Vec3 | null = null; // "вверх" в осях камеры
  private updatedAt = 0;
  private badSince: number | null = null;
  private badKind: TiltAdvice | null = null;
  private listening = false;

  private onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta == null || e.gamma == null) return;
    const b = e.beta * rad;
    const g = e.gamma * rad;
    // "вверх" в осях устройства
    const ux = -Math.cos(b) * Math.sin(g);
    const uy = Math.sin(b);
    const uz = Math.cos(b) * Math.cos(g);
    // -> оси камеры с учётом поворота экрана (картинка повёрнута вместе с ним)
    const a = screenAngle() * rad;
    const cx = Math.cos(a) * ux - Math.sin(a) * uy;
    const cy = -(Math.sin(a) * ux + Math.cos(a) * uy);
    this.up = [cx, cy, -uz];
    this.updatedAt = Date.now();

    const elev = Math.asin(Math.max(-1, Math.min(1, -uz))) / rad;
    this.elevation = elev;
    const kind: TiltAdvice | null = elev < TOO_LOW_DEG ? "raise" : elev > TOO_HIGH_DEG ? "lower" : null;
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

  /** "Вверх" в осях камеры (для сервера) или null, если датчика нет. */
  upVector(now: number): Vec3 | null {
    return this.up && now - this.updatedAt < STALE_MS ? this.up : null;
  }

  /** Совет по наклону, если плохой наклон держится долго; иначе null. */
  advice(now: number): TiltAdvice | null {
    if (now - this.updatedAt > STALE_MS) return null;
    return this.badKind && this.badSince != null && now - this.badSince >= SUSTAIN_MS ? this.badKind : null;
  }
}

export const cameraTilt = new CameraTilt();
