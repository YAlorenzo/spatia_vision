/** Средняя яркость кадра 0..255 и решение, включать ли фонарик. */

export const TORCH_ON_LUMA = 45;
export const TORCH_OFF_LUMA = 165;
const FRAMES_TO_ON = 2;
const FRAMES_TO_OFF = 6;

export interface TorchDecision {
  on: boolean;
  darkStreak: number;
  brightStreak: number;
}

/** Включить после нескольких тёмных кадров, выключить только когда стало заметно светлее.
 *  Порог выключения выше: включённый фонарик сам поднимает яркость кадра. */
export function nextTorch(on: boolean, luma: number, darkStreak: number, brightStreak: number): TorchDecision {
  const dark = luma < TORCH_ON_LUMA;
  const bright = luma > TORCH_OFF_LUMA;
  const nextDark = dark ? darkStreak + 1 : 0;
  const nextBright = bright ? brightStreak + 1 : 0;
  if (!on && nextDark >= FRAMES_TO_ON) return { on: true, darkStreak: 0, brightStreak: 0 };
  if (on && nextBright >= FRAMES_TO_OFF) return { on: false, darkStreak: 0, brightStreak: 0 };
  return { on, darkStreak: nextDark, brightStreak: nextBright };
}

const SAMPLE = 24;

/** Средняя яркость JPEG. На нативе без document возвращает null. */
export function measureLuma(base64: string): Promise<number | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = SAMPLE;
      canvas.height = SAMPLE;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
      const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
      let sum = 0;
      const pixels = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      resolve(sum / pixels);
    };
    img.onerror = () => resolve(null);
    img.src = base64.startsWith("data:") ? base64 : `data:image/jpeg;base64,${base64}`;
  });
}

/** true — у этой камеры есть вспышка, false — нет, null — поток ещё не готов. */
export function detectTorchSupport(): boolean | null {
  if (typeof document === "undefined") return false;
  const video = document.querySelector("video");
  const stream = video?.srcObject;
  if (!stream || typeof (stream as MediaStream).getVideoTracks !== "function") return null;
  const track = (stream as MediaStream).getVideoTracks()[0];
  if (!track) return null;
  const getCapabilities = (track as MediaStreamTrack & { getCapabilities?: () => { torch?: boolean } }).getCapabilities;
  if (typeof getCapabilities !== "function") return false;
  const caps = getCapabilities.call(track);
  return Boolean(caps && "torch" in caps && caps.torch);
}
