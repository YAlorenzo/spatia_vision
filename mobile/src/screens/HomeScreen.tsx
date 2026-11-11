import { Text, View, TouchableOpacity } from "react-native";

interface HomeScreenProps {
  onStart: () => void;
}

export const HomeScreen = ({ onStart }: HomeScreenProps) => {
  return (
    <View className="flex-1 bg-zinc-950 items-center justify-center">
      <Text className="text-white text-5xl font-black mb-2 text-center">
        SpatiaVision
      </Text>
      <Text className="text-zinc-400 text-lg mb-16 text-center">
        Пространственный ассистент
      </Text>

      <TouchableOpacity
        className="bg-blue-500 py-6 px-12 rounded-3xl active:bg-blue-600"
        onPress={onStart}
      >
        <Text className="text-white text-xl font-black uppercase text-center">
          Начать
        </Text>
      </TouchableOpacity>
    </View>
  );
};
