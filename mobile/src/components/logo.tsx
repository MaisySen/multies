import { View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { colors } from "@/theme";

/** The MyMail mark: an envelope on a vermilion tile, as in the web favicon. */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <View accessibilityRole="image" accessibilityLabel="MyMail"
      style={{ width: size, height: size, borderRadius: size * 0.25, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" }}>
      <Feather name="mail" size={size * 0.55} color={colors.brandFg} />
    </View>
  );
}
