import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/ui";
import { colors, lh, space, TOUCH } from "@/theme";

/** MPAR2: one row of a single choice list (Appearance, Language): a radio with a check on the picked one. */
export function Choice({ label, selected, onPress, left, testID, sub }: { label: string; selected: boolean; onPress: () => void; left?: ReactNode; testID?: string; sub?: string }) {
  return (
    <Pressable onPress={onPress} role="radio" aria-checked={selected} accessibilityRole="radio" accessibilityState={{ selected, checked: selected }} accessibilityLabel={sub ? `${label}, ${sub}` : label} testID={testID}
      style={({ pressed }) => [st.choice, pressed && Platform.OS !== "web" && { backgroundColor: colors.hover }]}>
      {left ? <View style={st.left}>{left}</View> : null}
      <View style={{ flex: 1, paddingVertical: 10 }}>
        <Text style={st.label}>{label}</Text>
        {sub ? <Text style={st.sub}>{sub}</Text> : null}
      </View>
      {selected ? <Icon name="check" size={20} color={colors.brand} /> : null}
    </Pressable>
  );
}

const st = StyleSheet.create({
  choice: { minHeight: Math.max(TOUCH, 48), flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, gap: space.md },
  left: { width: 28, alignItems: "center" },
  label: { color: colors.fg, fontSize: 17, lineHeight: Math.max(lh(22), 24) },
  sub: { color: colors.muted, fontSize: 13, lineHeight: lh(18), marginTop: 2 },
});
