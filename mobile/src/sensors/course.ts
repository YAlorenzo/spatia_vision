import { cameraTilt } from "./cameraTilt";

/**
 * Курс — направление, куда человек хочет идти.
 *
 * Без курса система знает только "что перед камерой": обходя препятствия по подсказкам, человек
 * постепенно уходит в сторону и не знает об этом. С курсом:
 *   - после обхода голос возвращает: "Turn left 40 degrees";
 *   - сервер выбирает сторону обхода ближе к курсу.
 * Курс задаётся кнопкой: запоминается, куда сейчас смотрит камера
 * (по датчику поворота телефона). Это направление, а не точка: "иди прямо туда".
 */

const norm = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

class Course {
  private target: number | null = null; // в градусах датчика (ноль произвольный)

  get isSet() {
    return this.target != null;
  }

  /** Запомнить: курс — туда, куда сейчас смотрит камера. false — нет датчика поворота. */
  set(now: number): boolean {
    const h = cameraTilt.heading(now);
    if (h == null) return false;
    this.target = h;
    return true;
  }

  clear() {
    this.target = null;
  }

  /** Куда курс относительно камеры, градусы: > 0 — правее, < 0 — левее; null — курс не задан / нет датчика. */
  deviation(now: number): number | null {
    const h = cameraTilt.heading(now);
    return this.target == null || h == null ? null : norm(this.target - h);
  }
}

export const course = new Course();

/**
 * На сколько повернуть, чтобы вернуться на курс: "Turn left 40 degrees" (округление до 5°),
 * "Turn around" — курс позади. Для голоса и экрана.
 */
export function courseText(dev: number): string {
  const a = Math.abs(dev);
  if (a > 150) return "Turn around";
  return `Turn ${dev > 0 ? "right" : "left"} ${Math.max(5, Math.round(a / 5) * 5)} degrees`;
}
