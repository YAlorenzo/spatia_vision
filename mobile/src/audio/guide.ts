import type { Clearance, Obstacle } from "../api/protocol";
import { classLabel, metersRu } from "../components/labels";

/**
 * Подсказки, как обойти препятствие, — когда человек ОСТАНОВИЛСЯ перед ним.
 *
 * Сервер в каждом кадре сообщает, насколько свободно в нескольких направлениях
 * (clearance). Камера вертикально видит по горизонтали всего ~40°, поэтому:
 *   1. Запоминаем, что было свободно, по направлению телефона (датчик ориентации) —
 *      "карта" вокруг человека собирается, пока он поворачивает телефон.
 *   2. Нашли свободное направление — ведём туда: "Свободно справа. Повернитесь направо".
 *      Камера смотрит в свободную сторону — "Свободно. Можно идти".
 *   3. Не нашли — просим осмотреться: "Медленно поверните телефон направо",
 *      потом "налево"; не нашлось нигде — "Прохода не видно".
 * Без датчика ориентации — только по тому, что видно в кадре сейчас.
 */

export interface GuideInput {
  obstacles: Obstacle[];
  clearance: Clearance | null;
  heading: number | null; // куда смотрит камера, градусы по часовой (ноль произвольный)
}

const BLOCK_M = 3.5; // препятствие на пути ближе этого — нужна подсказка
const AHEAD_BLOCK_M = 2.0; // ...или впереди свободно меньше этого (по карте глубины)
const GO_M = 3.0; // направление свободно, если свободно хотя бы на столько
const BIN_DEG = 5;
const MAP_TTL_MS = 20000;
const EXPLORE_DEG = 60; // осматриваемся в каждую сторону до стольких градусов от исходного
const SEARCH_DEG = 100; // дальше в сторону свободное направление не предлагаем
const ALIGN_DEG = 12; // камера смотрит почти туда — "идите"
const MIN_GAP_MS = 2500; // между подсказками
const REPEAT_MS = 6000; // та же подсказка — не чаще

const norm = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Свободно прямо по оси камеры (ближайшее к 0 направление). */
function aheadFree(c: Clearance | null): number | null {
  if (!c || !c.bearings.length) return null;
  let best = 0;
  c.bearings.forEach((b, i) => {
    if (Math.abs(b) < Math.abs(c.bearings[best])) best = i;
  });
  return c.free[best];
}

interface Advice {
  key: string;
  text: string;
}

export class GuideLogic {
  active = false;
  private h0: number | null = null; // куда смотрел человек, когда остановился
  private map = new Map<number, { free: number; at: number }>();
  private side: 1 | -1 = 1; // куда сначала осматриваемся
  private last: { key: string; at: number } = { key: "", at: -Infinity };
  private repeats = 0;

  reset() {
    this.active = false;
    this.h0 = null;
    this.map.clear();
    this.last = { key: "", at: -Infinity };
    this.repeats = 0;
  }

  /** Вызывать на каждом ответе сервера, пока человек стоит (даже если голос занят). */
  observe(inp: GuideInput, now: number) {
    const p = inp.obstacles.find((o) => o.primary && o.in_path);
    const ahead = aheadFree(inp.clearance);
    const blocked = (p != null && p.distance <= BLOCK_M) || (ahead != null && ahead < AHEAD_BLOCK_M);
    if (!this.active && blocked) {
      this.active = true;
      this.h0 = inp.heading;
      this.map.clear();
      this.side = this.freerSide(inp.clearance);
    }
    if (!this.active || inp.heading == null || !inp.clearance) return;
    const { bearings, free } = inp.clearance;
    bearings.forEach((b, i) => {
      const bin = norm(Math.round((inp.heading! + b) / BIN_DEG) * BIN_DEG);
      this.map.set(bin, { free: free[i], at: now });
    });
    for (const [k, v] of this.map) if (now - v.at > MAP_TTL_MS) this.map.delete(k);
  }

  /**
   * Срочная подсказка, которая ПЕРЕБИВАЕТ текущую фразу: человек поворачивает телефон по
   * просьбе "осмотритесь", и камера только что нашла свободное направление — сказать сразу,
   * иначе он проскочит его, пока голос договаривает.
   */
  urgent(inp: GuideInput, now: number): string | null {
    const turning = this.last.key.startsWith("scan") || this.last.key.startsWith("turn");
    if (!this.active || !turning) return null;
    const a = this.decide(inp);
    if (!a) return null;
    // осматривался -> нашли проход; поворачивался к проходу -> уже смотрит в него
    const found = this.last.key.startsWith("scan") ? a.key.startsWith("go") || a.key.startsWith("turn") : a.key.startsWith("go");
    if (!found) return null;
    this.last = { key: a.key, at: now };
    this.repeats = 0;
    return a.key.startsWith("go") ? `Стоп. ${a.text}` : a.text;
  }

  /** Что сказать сейчас (голос свободен) — или null. */
  pick(inp: GuideInput, now: number): string | null {
    if (!this.active || now - this.last.at < MIN_GAP_MS) return null;
    const a = this.decide(inp);
    if (!a) return null;
    const same = a.key === this.last.key;
    if (same && now - this.last.at < REPEAT_MS) return null;
    // "можно идти" и "прохода не видно" — не больше двух раз подряд
    if (same && (a.key.startsWith("go") || a.key === "none") && this.repeats >= 1) return null;
    this.repeats = same ? this.repeats + 1 : 0;
    const first = this.last.key === "";
    this.last = { key: a.key, at: now };
    if (first) {
      // Первая подсказка: что впереди + что делать
      const p = inp.obstacles.find((o) => o.primary && o.in_path);
      const what = p ? `${classLabel(p.cls)}, ${metersRu(p.distance)}` : "Впереди препятствие";
      return `${what}. ${a.text}`;
    }
    if (same && a.key.startsWith("scan")) return `Продолжайте. ${a.text}`;
    return a.text;
  }

  private decide(inp: GuideInput): Advice | null {
    const h = inp.heading;
    const p = inp.obstacles.find((o) => o.primary && o.in_path);
    const ahead = aheadFree(inp.clearance);

    // Камера смотрит в свободную сторону
    if (ahead != null && ahead >= GO_M && !(p && p.distance < GO_M)) {
      if (h == null || this.h0 == null || Math.abs(norm(h - this.h0)) < ALIGN_DEG) {
        return { key: "go", text: "Впереди свободно. Можно идти" };
      }
      return { key: "go-turned", text: "Сюда свободно. Повернитесь сюда и идите" };
    }

    if (h != null && this.h0 != null) {
      // Свободное направление из "карты" — ближайшее к исходному курсу
      let best: number | null = null;
      for (const [bin, v] of this.map) {
        const rel = norm(bin - this.h0);
        if (v.free < GO_M || Math.abs(rel) > SEARCH_DEG) continue;
        if (best == null || Math.abs(rel) < Math.abs(norm(best - this.h0))) best = bin;
      }
      if (best != null) {
        const delta = norm(best - h);
        if (Math.abs(delta) >= ALIGN_DEG) {
          const dir = delta > 0 ? "направо" : "налево";
          const amount = Math.abs(delta) < 25 ? "немного " : Math.abs(delta) > 70 ? "сильно " : "";
          return {
            key: `turn${delta > 0 ? "R" : "L"}`,
            text: `Свободно ${delta > 0 ? "справа" : "слева"}. Повернитесь ${amount}${dir}`,
          };
        }
      }
      // Свободного не знаем — осматриваемся: сначала в одну сторону, потом в другую
      const rels = [...this.map.keys()].map((b) => norm(b - this.h0!));
      const maxR = Math.max(0, ...rels);
      const minL = Math.min(0, ...rels);
      const done = (s: 1 | -1) => (s === 1 ? maxR >= EXPLORE_DEG : minL <= -EXPLORE_DEG);
      if (done(this.side) && !done(-this.side as 1 | -1)) this.side = -this.side as 1 | -1;
      if (!done(this.side)) {
        const right = this.side === 1;
        return {
          key: right ? "scanR" : "scanL",
          text: `Медленно поворачивайте телефон ${right ? "направо" : "налево"}`,
        };
      }
      return { key: "none", text: "Свободного прохода не видно. Попробуйте вернуться назад" };
    }

    // Нет датчика ориентации — только то, что видно сейчас
    const c = inp.clearance;
    if (c) {
      let best: number | null = null;
      c.bearings.forEach((b, i) => {
        if (c.free[i] >= GO_M && (best == null || Math.abs(b) < Math.abs(best))) best = b;
      });
      if (best != null) {
        const right = best > 0;
        return { key: `turn${right ? "R" : "L"}`, text: `Свободно чуть ${right ? "правее" : "левее"}. Повернитесь немного ${right ? "направо" : "налево"}` };
      }
    }
    const right = this.repeats % 2 === 0;
    return { key: right ? "scanR" : "scanL", text: `Поверните телефон ${right ? "направо" : "налево"} и осмотритесь` };
  }

  /** С какой стороны в кадре свободнее — туда и осматриваемся сначала. */
  private freerSide(c: Clearance | null): 1 | -1 {
    if (!c) return 1;
    let l = 0;
    let r = 0;
    c.bearings.forEach((b, i) => {
      if (b < 0) l += c.free[i];
      if (b > 0) r += c.free[i];
    });
    return l > r ? -1 : 1;
  }
}
