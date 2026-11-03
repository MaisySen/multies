import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Icon, type IconName } from "./ui";
import { tick } from "@/lib/haptics";
import { colors, gradient, hairline, radius, raised, shadow, space } from "@/theme";

/**
 * M4 design system pieces: a gradient hero card (react-native-svg, already in the store build),
 * glass pills for quick actions on it, and a tinted icon circle for list rows and stats.
 */
/**
 * M5: the gradient is drawn at the card's measured size. 1.10.12 drew it with width and height "100%" inside an absolute
 * fill, which iOS sized before the card's content had laid out, so the colour stopped short on the right and under the
 * buttons. The card also carries the first gradient colour as a solid fill, so it never shows a gap.
 */
export function GradientFill({ stops = gradient.brand, r = radius.xl, width, height, testID }: { stops?: readonly string[]; r?: number; width: number; height: number; testID?: string }) {
  if (!width || !height) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID={testID}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="m5g" x1="0" y1="0" x2="1" y2="1">
            {stops.map((c, i) => <Stop key={c} offset={i / Math.max(1, stops.length - 1)} stopColor={c} />)}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} rx={r} ry={r} fill="url(#m5g)" />
      </Svg>
    </View>
  );
}

export function Hero({ title, subtitle, children, testID, style }: { title: string; subtitle?: string | null; children?: ReactNode; testID?: string; style?: StyleProp<ViewStyle> }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (Math.abs(width - size.width) > 0.5 || Math.abs(height - size.height) > 0.5) setSize({ width, height });
  };
  return (
    <View style={[h.hero, style]} testID={testID} onLayout={onLayout}>
      <GradientFill width={size.width} height={size.height} testID={testID ? `${testID}-fill` : undefined} />
      <Text style={h.title} accessibilityRole="header" numberOfLines={2} maxFontSizeMultiplier={1.4}>{title}</Text>
      {subtitle ? <Text style={h.sub} numberOfLines={3} maxFontSizeMultiplier={1.4}>{subtitle}</Text> : null}
      {children ? <View style={h.actions}>{children}</View> : null}
    </View>
  );
}

/** M5: a quick action on the hero. Three share the row evenly (icon over label), so they never wrap or spill. */
export function HeroAction({ icon, label, onPress, testID }: { icon: IconName; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={() => { tick(); onPress(); }} testID={testID} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [h.action, pressed && { opacity: 0.75, transform: [{ scale: 0.97 }] }]}>
      <Icon name={icon} size={20} color="#FFFFFF" />
      <Text style={h.actionText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.3}>{label}</Text>
    </Pressable>
  );
}

/** M5: a section title with an optional action on the right ("See all"), the one header for lists on the home screens. */
export function SectionHeader({ title, action, onAction, testID }: { title: string; action?: string; onAction?: () => void; testID?: string }) {
  return (
    <View style={h.section} testID={testID}>
      <Text style={h.sectionTitle} accessibilityRole="header" numberOfLines={1}>{title}</Text>
      {action && onAction ? (
        <Pressable onPress={() => { tick(); onAction(); }} accessibilityRole="button" accessibilityLabel={`${action}, ${title}`} hitSlop={12}>
          <Text style={h.sectionAction}>{action}</Text>
        </Pressable>
      ) : null}
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
  hero: { alignSelf: "stretch", borderRadius: radius.xl, padding: space.xl, paddingBottom: space.lg, gap: 6, overflow: "hidden", backgroundColor: gradient.brand[0], ...raised },
  title: { color: "#FFFFFF", fontSize: 26, fontWeight: "700", letterSpacing: 0.2 },
  sub: { color: "rgba(255,255,255,0.88)", fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  action: { flex: 1, minHeight: 60, alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.md, backgroundColor: "rgba(255,255,255,0.18)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.32)" },
  actionText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  section: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.md, marginTop: space.md, paddingHorizontal: space.xs },
  sectionTitle: { flex: 1, color: colors.fg, fontSize: 20, fontWeight: "700", letterSpacing: 0.35 },
  sectionAction: { color: colors.brand, fontSize: 15, fontWeight: "600" },
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
