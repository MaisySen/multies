import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

/** R31: small haptic cues (expo-haptics is already in the app; nothing on the web). */
export function tick() {
  if (Platform.OS !== "web") Haptics.selectionAsync?.()?.catch(() => {});
}
export function thud() {
  if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}
export function success() {
  if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}
