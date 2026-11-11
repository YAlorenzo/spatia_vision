import { useEffect, useRef } from "react";
import { View, TouchableOpacity, Text } from "react-native";
import { CameraView } from "expo-camera";
import { cssInterop } from "nativewind";
import { useServerStream } from "../api/useServerStream";

// CameraView — сторонний компонент, NativeWind должен знать, что className -> style
cssInterop(CameraView, { className: "style" });

interface ScannerScreenProps {
  onStop: () => void;
  serverUrl: string;
}

export const ScannerScreen = ({ onStop, serverUrl }: ScannerScreenProps) => {
  const cameraRef = useRef<CameraView | null>(null);
  const { sendFrame } = useServerStream(serverUrl);

  useEffect(() => {
    console.log("▶️ Запуск цикла захвата...");
    const interval = setInterval(async () => {
      if (cameraRef.current) {
        try {
          const photo = await cameraRef.current.takePictureAsync({
            quality: 0.1,
            base64: true,
          });
          if (photo?.base64) {
            sendFrame(photo.base64);
            console.log("🚀 Кадр отправлен");
          }
        } catch (e) {
          console.error("Ошибка захвата кадра:", e);
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [sendFrame]);

  return (
    <View className="flex-1 bg-zinc-950">
      <CameraView ref={cameraRef} className="flex-1" facing="back" />

      <View className="absolute bottom-12 w-full items-center">
        <TouchableOpacity
          className="bg-red-500 py-6 w-4/5 rounded-3xl items-center active:bg-red-600"
          onPress={onStop}
        >
          <Text className="text-white text-2xl font-black uppercase text-center">
            Остановить
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
