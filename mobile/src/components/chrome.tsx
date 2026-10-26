import { useState } from "react";
import { LayoutAnimation, Platform, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { colors, scheme } from "@/theme";
import { nativeBlur } from "@/lib/native-modules";

/** "#RRGGBB" to "rgba(r,g,b,a)". Anything else comes back as it was. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/**
 * R34: translucent chrome. Until real blur materials ship in a native build (native batch 1), bars
 * use a semi-opaque surface with a hairline edge, the closest look that stays JS only.
 */
export const chrome = {
  barColor: withAlpha(colors.surface, 0.92),
  tabBar: { backgroundColor: withAlpha(colors.surface, 0.94), borderTopColor: colors.line, borderTopWidth: StyleSheet.hairlineWidth, elevation: 0 },
  header: { backgroundColor: withAlpha(colors.bg, 0.94), borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
};

/** R37: whether bars can draw a real blur material (iOS builds from 1.10.0 with expo-blur). */
export function hasBarBlur(): boolean {
  return Platform.OS === "ios" && !!nativeBlur();
}

/**
 * R37: the system chrome material behind a bar (tab bar, compact title bar). Draws nothing where
 * expo-blur is missing, so the semi-opaque surface colour above stays the look there.
 */
export function BarBlur() {
  const B = Platform.OS === "ios" ? nativeBlur() : null;
  if (!B) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="bar-blur">
      <B.BlurView intensity={80} tint={scheme === "dark" ? "systemChromeMaterialDark" : "systemChromeMaterialLight"} style={StyleSheet.absoluteFill} />
    </View>
  );
}

/** Past this many points of scroll the large title has gone and the compact bar shows. */
export const COLLAPSE_AT = 44;

/** Whether the compact title bar shows at this scroll offset. */
export function collapsed(offsetY: number): boolean {
  return offsetY > COLLAPSE_AT;
}

/**
 * R34: a large title that collapses into a compact bar on scroll, the way iOS lists do. Spread
 * `scrollProps` on the list and pass `collapsed` to LargeTitle.
 */
export function useCollapse() {
  const [isCollapsed, setCollapsed] = useState(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = collapsed(e.nativeEvent.contentOffset.y);
    if (next === isCollapsed) return;
    if (Platform.OS !== "web") LayoutAnimation.configureNext(LayoutAnimation.create(180, "easeInEaseOut", "opacity"));
    setCollapsed(next);
  };
  return { collapsed: isCollapsed, scrollProps: { onScroll, scrollEventThrottle: 16 } };
}
