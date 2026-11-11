import { useEffect, useRef, useCallback } from "react";

export const useServerStream = (url: string) => {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(url);

    ws.onopen = () => console.log("✅ [WS] Соединение установлено");
    ws.onmessage = (event) => console.log("🔊 [WS] Ответ сервера:", event.data);
    ws.onerror = (error) => console.error("❌ [WS] Ошибка:", error);
    ws.onclose = () => console.log("🔌 [WS] Соединение закрыто");

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, [url]);

  const sendFrame = useCallback((base64: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({
          type: "frame",
          image: base64,
        }),
      );
    }
  }, []);

  return { sendFrame };
};
