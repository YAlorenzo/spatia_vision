import { Platform } from "react-native";

/**
 * Голосовые команды — распознавание речи браузера (Web Speech API).
 * Работает в Chrome на Android (нужен интернет и доступ к микрофону); в Safari на iPhone —
 * не везде. Слушаем по нажатию кнопки, одну короткую фразу: постоянно слушать нельзя —
 * микрофон ловил бы собственные сигналы и голос приложения.
 */

export type Command = "course" | "clear_course" | "where" | "ahead" | "verbose" | "brief" | "repeat";

// Порядок важен: "сброс курса" должен найтись раньше, чем "курс"
const PATTERNS: [Command, RegExp][] = [
  ["clear_course", /сброс|отмен|убери курс|без курса/],
  ["where", /куда|где курс|направлени/],
  ["course", /курс|запомни|прямо туда|иду туда/],
  ["ahead", /что вперед|что впереди|что там|обстановк|что вокруг/],
  ["verbose", /подробн/],
  ["brief", /кратк|короч|тише|помолч/],
  ["repeat", /повтор|ещё раз|еще раз/],
];

export function parseCommand(text: string): Command | null {
  const t = text.toLowerCase().replace(/ё/g, "е");
  for (const [cmd, re] of PATTERNS) if (re.test(t) || re.test(text.toLowerCase())) return cmd;
  return null;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

function ctor(): (new () => Recognition) | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceSupported = () => ctor() != null;

/**
 * Послушать одну фразу. onDone(текст | null, ошибка | null) вызывается ровно один раз.
 * Возвращает функцию отмены.
 */
export function listenOnce(onDone: (text: string | null, error: string | null) => void): () => void {
  const C = ctor();
  if (!C) {
    onDone(null, "unsupported");
    return () => {};
  }
  const rec = new C();
  let finished = false;
  const finish = (text: string | null, error: string | null) => {
    if (finished) return;
    finished = true;
    onDone(text, error);
  };
  rec.lang = "ru-RU";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (e) => finish(e.results[0]?.[0]?.transcript ?? null, null);
  rec.onerror = (e) => finish(null, e.error);
  rec.onend = () => finish(null, "no-speech");
  try {
    rec.start();
  } catch {
    finish(null, "start-failed");
  }
  return () => rec.abort();
}
