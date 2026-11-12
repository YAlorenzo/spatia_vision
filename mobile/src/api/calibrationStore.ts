import type { Scene } from "./protocol";

export interface SceneCalibration {
  depthScale: number;
  hfov?: number;
}

const KEY = "spatia.calibration.v1";

type Store = Partial<Record<Scene, SceneCalibration>>;

function read(): Store {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Store;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function write(store: Store) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // приватный режим или натив без localStorage — калибровка живёт только в сессии
  }
}

export function loadSceneCalibration(scene: Scene): SceneCalibration | null {
  const saved = read()[scene];
  if (!saved || typeof saved.depthScale !== "number") return null;
  return saved;
}

export function saveSceneCalibration(scene: Scene, value: SceneCalibration) {
  const store = read();
  store[scene] = value;
  write(store);
}

export function clearSceneCalibration(scene: Scene) {
  const store = read();
  delete store[scene];
  write(store);
}
