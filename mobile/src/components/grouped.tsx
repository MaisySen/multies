import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import { Animated, Pressable, Switch, Text, View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { colors, font, space } from "@/theme";
import { tick, warning } from "@/lib/haptics";
import { useReduceMotion } from "@/lib/motion";
import { Icon, TILE, type IconName, type TileColor } from "./ui";

/**
 * R36: the inset grouped list (iOS Settings, measured in files/teardowns/rea/monday/task-detail-settings-r36.md):
 * 16 pt side inset, 12 pt radius, rows at least 44 pt (48 for property rows), 29 pt tiles with a
 * 7 pt radius, separators that start after the tile, a 13 pt header above and a 13 pt muted footer.
 */
export const GROUP = { inset: 16, radius: 12, row: 48, tile: 29, tileRadius: 7, gap: 28, text: 13 } as const;

export function InsetGroup({ header, footer, children, style, testID }: { header?: string; footer?: string; children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const items = Children.toArray(children).filter((c) => isValidElement(c));
  return (
    <View style={[{ marginTop: GROUP.gap - 8 }, style]} testID={testID}>
      {header ? <Text style={g.header} accessibilityRole="header">{header}</Text> : null}
      <View style={g.group}>
        {items.map((c, i) => (
          <View key={i}>
            {c}
            {i < items.length - 1 ? <View style={g.sep} /> : null}
          </View>
        ))}
      </View>
      {footer ? <Text style={g.footer}>{footer}</Text> : null}
    </View>
  );
}

type RowProps = {
  label: string; icon?: IconName; tile?: TileColor; value?: string | null; sub?: string | null;
  onPress?: () => void; destructive?: boolean; chevron?: boolean; right?: ReactNode; testID?: string; hint?: string;
  /** A switch on the right. Changing it plays the selection haptic. */
  toggle?: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean };
};

export function GroupRow({ label, icon, tile, value, sub, onPress, destructive, chevron, right, testID, hint, toggle }: RowProps) {
  const fg = destructive ? colors.bad : colors.fg;
  const body = (
    <>
      {icon ? (tile ? (
        <View style={[g.tile, { backgroundColor: destructive ? TILE.red : TILE[tile] }]}><Icon name={icon} size={17} color="#FFFFFF" filled /></View>
      ) : <View style={g.bare}><Icon name={icon} size={20} color={destructive ? colors.bad : colors.brand} /></View>) : null}
      <View style={{ flex: 1, paddingVertical: 11 }}>
        <Text style={[g.label, { color: fg }]} numberOfLines={2}>{label}</Text>
        {sub ? <Text style={g.sub} numberOfLines={3}>{sub}</Text> : null}
      </View>
      {value ? <Text style={g.value} numberOfLines={1}>{value}</Text> : null}
      {right}
      {toggle ? (
        <Switch value={toggle.value} disabled={toggle.disabled} accessibilityLabel={label} testID={testID ? `${testID}-switch` : undefined}
          trackColor={{ true: TILE.green, false: colors.elevated }} onValueChange={(v) => { tick(); toggle.onChange(v); }} />
      ) : null}
      {onPress && (chevron ?? !destructive) && !toggle ? <Icon name="chevron-right" size={16} color={colors.subtle} /> : null}
    </>
  );
  if (!onPress) {
    return <View style={g.row} testID={testID} accessible={!toggle} accessibilityLabel={value ? `${label}, ${value}` : label}>{body}</View>;
  }
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={value ? `${label}, ${value}` : label} accessibilityHint={hint}
      onPress={() => { if (destructive) warning(); else tick(); onPress(); }}
      style={({ pressed }) => [g.row, pressed && { backgroundColor: colors.hover }]}>
      {body}
    </Pressable>
  );
}

/** R36: fades and lifts its children in once, on the shared spring. Still with Reduce Motion on. */
export function SpringIn({ children, delay = 0, style }: { children: ReactNode; delay?: number; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const [v] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) { v.setValue(1); return; }
    const a = Animated.spring(v, { toValue: 1, damping: 22, stiffness: 260, mass: 1, delay, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [reduce, delay, v]);
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }]}>{children}</Animated.View>;
}

export const g = StyleSheet.create({
  header: { color: colors.subtle, fontSize: GROUP.text, textTransform: "uppercase", letterSpacing: 0.3, marginHorizontal: GROUP.inset * 2, marginBottom: 7 },
  footer: { color: colors.subtle, fontSize: GROUP.text, lineHeight: 18, marginHorizontal: GROUP.inset * 2, marginTop: 7 },
  group: { marginHorizontal: GROUP.inset, borderRadius: GROUP.radius, backgroundColor: colors.surface, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginLeft: GROUP.inset + GROUP.tile + space.md },
  row: { minHeight: GROUP.row, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: GROUP.inset },
  tile: { width: GROUP.tile, height: GROUP.tile, borderRadius: GROUP.tileRadius, alignItems: "center", justifyContent: "center" },
  bare: { width: GROUP.tile, alignItems: "center" },
  label: { ...font.body, fontSize: 17 },
  sub: { color: colors.subtle, fontSize: 13, lineHeight: 18, marginTop: 2 },
  value: { color: colors.subtle, fontSize: 17, maxWidth: "45%" },
});
