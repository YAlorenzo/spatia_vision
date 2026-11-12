import "./global.css";
import { useState } from "react";
import { Text, View, TouchableOpacity, Platform } from "react-native";
import { useCameraPermissions } from "expo-camera";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ScannerScreen } from "./src/screens/ScannerScreen";
import { unlockAudio } from "./src/audio/useAudioFeedback";


export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [isScanning, setIsScanning] = useState(false);

  if (Platform.OS !== "web" && !permission) {
    return <View className="flex-1 bg-zinc-950" />;
  }

  if (Platform.OS !== "web" && permission && !permission.granted) {
    return (
      <View className="flex-1 bg-zinc-950 items-center justify-center">
        <Text className="text-white text-3xl font-bold mb-8 text-center">
          Доступ к камере
        </Text>
        <TouchableOpacity
          className="bg-blue-500 py-4 px-10 rounded-2xl active:bg-blue-600"
          onPress={requestPermission}
        >
          <Text className="text-white text-xl font-black uppercase">
            Разрешить
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (isScanning) {
    return <ScannerScreen onStop={() => setIsScanning(false)} />;
  }

  return (
    <HomeScreen
      onStart={() => {
        unlockAudio(); // браузер разрешает звук только в обработчике нажатия
        setIsScanning(true);
      }}
    />
  );
}
