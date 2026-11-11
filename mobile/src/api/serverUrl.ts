import { Platform } from "react-native";

const METRO_PORT = "8081";
const SERVER_PORT = "8000";

/**
 * Адрес WebSocket-сервера:
 * 1. EXPO_PUBLIC_SERVER_URL из .env.local — если задан, всегда он.
 * 2. Веб, открыт с dev-сервера Metro (:8081) — тот же хост, порт 8000.
 * 3. Веб, открыт с самого сервера (собранная версия / туннель) — тот же адрес, /ws.
 */
export function getServerUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_SERVER_URL;
  if (fromEnv) return fromEnv;

  if (Platform.OS === "web" && typeof window !== "undefined") {
    const { protocol, hostname, port, host } = window.location;
    const ws = protocol === "https:" ? "wss" : "ws";
    if (port === METRO_PORT) return `${ws}://${hostname}:${SERVER_PORT}/ws`;
    return `${ws}://${host}/ws`;
  }

  return `ws://localhost:${SERVER_PORT}/ws`;
}
