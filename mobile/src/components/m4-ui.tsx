import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Icon, type IconName } from "./ui";
import { tick } from "@/lib/haptics";
import { colors, gradient, hairline, radius, raised, shadow, space } from "@/theme";

/**
 * M4 design system pieces: a gradient hero card (react-native-svg, already in the store build),
 * glass pills for quick actions on it, and a tinted icon circle for list rows and stats.
 */
export function GradientFill({ stops = gradient.brand, r = radius.xl }: { stops?: readonly string[]; r?: number }) {
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id="m4g" x1="0" y1="0" x2="1" y2="1">
          {stops.map((c, i) => <Stop key={c} offset={i / Math.max(1, stops.length - 1)} stopColor={c} />)}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" rx={r} ry={r} fill="url(#m4g)" />
    </Svg>
  );
}

export function Hero({ title, subtitle, children, testID, style }: { title: string; subtitle?: string | null; children?: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[h.hero, style]} testID={testID}>
      <GradientFill />
      <Text style={h.title} accessibilityRole="header" numberOfLines={2}>{title}</Text>
      {subtitle ? <Text style={h.sub} numberOfLines={2}>{subtitle}</Text> : null}
      {children ? <View style={h.actions}>{children}</View> : null}
    </View>
  );
}

export function GlassPill({ icon, label, onPress, testID }: { icon: IconName; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={() => { tick(); onPress(); }} testID={testID} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [h.pill, pressed && { opacity: 0.7, transform: [{ scale: 0.96 }] }]}>
      <Icon name={icon} size={17} color="#FFFFFF" />
      <Text style={h.pillText} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** A soft tinted circle with a coloured icon: the row and stat icon of the M4 look. */
export function TintIcon({ icon, color, size = 40 }: { icon: IconName; color: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tint(color), alignItems: "center", justifyContent: "center" }}>
      <Icon name={icon} size={Math.round(size * 0.5)} color={color} filled />
    </View>
  );
}

/** #RRGGBB at 15 percent, for tinted fills. */
export function tint(hex: string, alpha = 0.15): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return colors.brandSoft;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const h = StyleSheet.create({
  hero: { borderRadius: radius.xl, padding: space.xl, paddingBottom: space.lg, gap: 6, overflow: "hidden", ...raised },
  title: { color: "#FFFFFF", fontSize: 26, fontWeight: "700", letterSpacing: 0.2 },
  sub: { color: "rgba(255,255,255,0.88)", fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.2)", borderWidth: 1, borderColor: "rgba(255,255,255,0.28)" },
  pillText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
});

/** M4: the shared card, row and separator of the new list screens. */
export const m4s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: "hidden", borderWidth: hairline ? StyleSheet.hairlineWidth : 0, borderColor: colors.line, ...shadow },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 64 },
  sep: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
});
