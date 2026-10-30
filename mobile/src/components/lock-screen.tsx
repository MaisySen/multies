import { StyleSheet, Text, View } from "react-native";
import { Button } from "./ui";
import { Logo } from "./logo";
import { colors, font, space } from "@/theme";

/** R37: covers the app until Face ID or the fingerprint check passes (Settings, Unlock with Face ID). */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.bg, alignItems: "center", justifyContent: "center", gap: space.lg, padding: space.xl }]}
      testID="lock-screen" accessibilityViewIsModal>
      <Logo size={64} />
      <Text style={[font.heading, { textAlign: "center" }]} accessibilityRole="header">Multies is locked</Text>
      <Text style={[font.small, { textAlign: "center" }]}>Unlock to see your mail and tasks.</Text>
      <Button label="Unlock" onPress={onUnlock} />
    </View>
  );
}
