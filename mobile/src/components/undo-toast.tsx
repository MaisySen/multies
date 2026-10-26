import { useEffect, useState } from "react";
import { AccessibilityInfo, Animated, Pressable, Text, View } from "react-native";
import { useReduceMotion } from "@/lib/motion";
import type { PendingAction } from "@/lib/swipe";
import { colors, motion, radius, space } from "@/theme";

/** R31: "Archived. Undo" at the bottom of a list while a swiped action waits to run. */
export function UndoToast({ pending, onUndo, bottom = space.lg }: { pending: PendingAction | null; onUndo: (key: string) => void; bottom?: number }) {
  const reduce = useReduceMotion();
  const [y] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (pending) AccessibilityInfo.announceForAccessibility?.(`${pending.label}. Undo is available.`);
    Animated.timing(y, { toValue: pending ? 1 : 0, duration: reduce ? 0 : motion.fast, useNativeDriver: true }).start();
  }, [pending, reduce, y]);
  if (!pending) return null;
  return (
    <Animated.View pointerEvents="box-none" style={{ position: "absolute", left: space.lg, right: space.lg, bottom, opacity: y, transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }}>
      <View accessibilityLiveRegion="polite" testID="undo-toast"
        style={{ flexDirection: "row", alignItems: "center", gap: space.md, backgroundColor: colors.fg, borderRadius: radius.lg, paddingLeft: space.lg, paddingRight: space.sm, minHeight: 48,
          shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
        <Text style={{ color: colors.bg, fontSize: 15, flex: 1 }} numberOfLines={1}>{pending.label}</Text>
        <Pressable onPress={() => onUndo(pending.key)} accessibilityRole="button" accessibilityLabel="Undo" testID="undo"
          style={({ pressed }) => ({ paddingHorizontal: space.md, minHeight: 40, justifyContent: "center", borderRadius: radius.md, opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "700" }}>Undo</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
