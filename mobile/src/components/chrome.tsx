import { useState } from "react";
import { LayoutAnimation, Platform, StyleSheet, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { colors } from "@/theme";

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
