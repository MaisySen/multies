import { forwardRef, useEffect, useState, type ComponentRef, type ReactNode } from "react";
import {
  ActivityIndicator, Animated, Easing, Pressable, StyleSheet, Text, TextInput, View,
  type PressableProps, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import { colors, font, motion, radius, shadow, space, TOUCH } from "@/theme";
import { initials } from "@/lib/format";
import { useReduceMotion } from "@/lib/motion";
import { ICONS, type IconName } from "./icons";

export type { IconName } from "./icons";

/** A Lucide line icon (ISC licence), 2 pt stroke, hidden from screen readers: the control carries the label. */
export function Icon({ name, size = 20, color = colors.muted }: { name: IconName; size?: number; color?: string }) {
  const Glyph = ICONS[name];
  return <Glyph size={size} color={color} strokeWidth={size <= 16 ? 2.25 : 2} accessibilityElementsHidden importantForAccessibility="no" testID={`icon-${name}`} />;
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({ label, onPress, variant = "primary", icon, loading, disabled, style, accessibilityHint, testID }: {
  label: string; onPress?: () => void; variant?: Variant; icon?: IconName; loading?: boolean; disabled?: boolean;
  style?: StyleProp<ViewStyle>; accessibilityHint?: string; testID?: string;
}) {
  const v = variants[variant];
  const off = disabled || loading;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [styles.button, { backgroundColor: pressed ? v.pressed : v.bg, borderColor: v.border, opacity: off ? 0.55 : 1 }, style]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : icon ? <Icon name={icon} size={18} color={v.fg} /> : null}
      <Text style={[styles.buttonText, { color: v.fg }]}>{label}</Text>
    </Pressable>
  );
}

const variants: Record<Variant, { bg: string; pressed: string; fg: string; border: string }> = {
  primary: { bg: colors.brandFill, pressed: colors.brandHover, fg: colors.brandFg, border: colors.brandFill },
  secondary: { bg: colors.elevated, pressed: colors.hover, fg: colors.fg, border: colors.lineStrong },
  ghost: { bg: "transparent", pressed: colors.hover, fg: colors.fg, border: "transparent" },
  danger: { bg: colors.badSoft, pressed: "rgba(251,113,133,0.2)", fg: colors.bad, border: "rgba(251,113,133,0.35)" },
};

export function IconButton({ icon, label, onPress, color = colors.fg, testID, badge }: { icon: IconName; label: string; onPress?: () => void; color?: string; testID?: string; badge?: boolean }) {
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6}
      style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.hover }]}>
      <Icon name={icon} size={21} color={color} />
      {badge ? <View style={styles.iconBadge} /> : null}
    </Pressable>
  );
}

export const Field = forwardRef<ComponentRef<typeof TextInput>, TextInputProps & { label: string; error?: string | null; hint?: string }>(
  function Field({ label, error, hint, style, ...props }, ref) {
    return (
      <View style={{ gap: 6 }}>
        <Text style={styles.label} nativeID={`${props.testID ?? label}-label`}>{label}</Text>
        <TextInput
          ref={ref}
          placeholderTextColor={colors.subtle}
          selectionColor={colors.brand}
          accessibilityLabel={label}
          accessibilityHint={hint}
          style={[styles.input, error ? { borderColor: colors.bad } : null, style as StyleProp<TextStyle>]}
          {...props}
        />
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : hint ? <Text style={font.tiny}>{hint}</Text> : null}
      </View>
    );
  },
);

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type Tone = "brand" | "ok" | "warn" | "bad" | "neutral";
const tones: Record<Tone, { bg: string; fg: string }> = {
  brand: { bg: colors.brandSoft, fg: colors.brand },
  ok: { bg: colors.okSoft, fg: colors.ok },
  warn: { bg: colors.warnSoft, fg: colors.warn },
  bad: { bg: colors.badSoft, fg: colors.bad },
  neutral: { bg: colors.neutralSoft, fg: colors.muted },
};

export function Badge({ label, tone = "neutral", icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const t = tones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t.bg }]}>
      {icon ? <Icon name={icon} size={12} color={t.fg} /> : null}
      <Text style={[styles.badgeText, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

export function Avatar({ name, agent, size = 40 }: { name: string; agent?: boolean; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: agent ? colors.brandSoft : colors.elevated }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {agent ? <Icon name="cpu" size={size * 0.45} color={colors.brand} /> : <Text style={{ color: colors.fg, fontWeight: "600", fontSize: size * 0.36 }}>{initials(name)}</Text>}
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty} accessible accessibilityLabel={`${title}. ${body ?? ""}`}>
      <View style={styles.emptyIcon}><Icon name={icon} size={26} color={colors.brand} /></View>
      <Text style={[font.heading, { textAlign: "center" }]}>{title}</Text>
      {body ? <Text style={[font.small, { textAlign: "center", maxWidth: 300 }]}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable key={o.id} onPress={() => onChange(o.id)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={o.label}
            style={[styles.segment, on && { backgroundColor: colors.hover }]}>
            <Text style={{ color: on ? colors.fg : colors.muted, fontWeight: on ? "600" : "500", fontSize: 14 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, selected, onPress, count }: { label: string; selected?: boolean; onPress?: () => void; count?: number }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!selected }} accessibilityLabel={count ? `${label}, ${count} unread` : label}
      style={[styles.chip, selected && { backgroundColor: colors.brandSoft, borderColor: colors.brandLine }]}>
      <Text style={{ color: selected ? colors.brand : colors.muted, fontWeight: "600", fontSize: 14 }}>{label}</Text>
      {count ? <Text style={{ color: selected ? colors.brand : colors.subtle, fontSize: 13 }}>{count}</Text> : null}
    </Pressable>
  );
}

export function Banner({ tone = "warn", icon = "wifi-off", text }: { tone?: Tone; icon?: IconName; text: string }) {
  const t = tones[tone];
  return (
    <View style={[styles.banner, { backgroundColor: t.bg }]} accessibilityRole="alert">
      <Icon name={icon} size={16} color={t.fg} />
      <Text style={{ color: t.fg, fontSize: 14, flex: 1 }}>{text}</Text>
    </View>
  );
}

export function SectionTitle({ children }: { children: string }) {
  return <Text style={styles.section} accessibilityRole="header">{children}</Text>;
}

export function Row({ icon, label, value, onPress, danger, testID }: { icon: IconName; label: string; value?: string; onPress?: () => void; danger?: boolean; testID?: string }) {
  const content = (
    <>
      <Icon name={icon} size={19} color={danger ? colors.bad : colors.muted} />
      <Text style={{ flex: 1, color: danger ? colors.bad : colors.fg, fontSize: 16 }}>{label}</Text>
      {value ? <Text style={{ color: colors.subtle, fontSize: 14, maxWidth: "50%" }} numberOfLines={1}>{value}</Text> : null}
      {onPress ? <Icon name="chevron-right" size={18} color={colors.subtle} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.row} accessible accessibilityLabel={value ? `${label}: ${value}` : label}>{content}</View>;
  return (
    <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={value ? `${label}, ${value}` : label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]}>
      {content}
    </Pressable>
  );
}

/** A gently pulsing placeholder block. Still when Reduce Motion is on. */
export function Skeleton({ width, height = 14, radius: r = 6, style }: { width?: number | `${number}%`; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const reduce = useReduceMotion();
  const [pulse] = useState(() => new Animated.Value(0.55));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.55, duration: 700, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduce, pulse]);
  return <Animated.View style={[{ width: width ?? "100%", height, borderRadius: r, backgroundColor: colors.elevated, opacity: pulse }, style]} />;
}

/** Loading state: skeleton rows shaped like a list, instead of a spinner. */
export function Loading({ label = "Loading", rows = 6 }: { label?: string; rows?: number }) {
  return (
    <View style={{ paddingVertical: space.md }} accessible accessibilityRole="progressbar" accessibilityLabel={label} testID="loading">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md }}>
          <Skeleton width={36} height={36} radius={18} />
          <View style={{ flex: 1, gap: space.sm }}>
            <Skeleton width={i % 2 ? "55%" : "70%"} height={13} />
            <Skeleton width={i % 3 ? "85%" : "65%"} height={11} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** A large title header (34 pt), as iOS shows at the top of a tab, with optional actions on the right. */
export function LargeTitle({ title, subtitle, right, top = 0 }: { title: string; subtitle?: string | null; right?: ReactNode; top?: number }) {
  return (
    <View style={{ paddingTop: top + space.md, paddingHorizontal: space.lg, paddingBottom: space.sm, flexDirection: "row", alignItems: "flex-end", gap: space.sm, backgroundColor: colors.bg }}>
      <View style={{ flex: 1 }}>
        <Text style={font.largeTitle} accessibilityRole="header" numberOfLines={1}>{title}</Text>
        {subtitle ? <Text style={font.tiny} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={{ flexDirection: "row", alignItems: "center", paddingBottom: 2 }}>{right}</View> : null}
    </View>
  );
}

export { motion };

export function PressableCard(props: PressableProps & { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { style, children, ...rest } = props;
  return <Pressable {...rest} style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.elevated }, style]}>{children}</Pressable>;
}

export const styles = StyleSheet.create({
  button: { minHeight: TOUCH + 4, borderRadius: radius.md, paddingHorizontal: space.lg, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: "600" },
  iconButton: { width: TOUCH, height: TOUCH, borderRadius: TOUCH / 2, alignItems: "center", justifyContent: "center" },
  iconBadge: { position: "absolute", top: 9, right: 9, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.bad, borderWidth: 2, borderColor: colors.bg },
  label: { color: colors.muted, fontSize: 14, fontWeight: "500" },
  input: { minHeight: TOUCH + 4, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, color: colors.fg, paddingHorizontal: space.md, fontSize: 16 },
  error: { color: colors.bad, fontSize: 13 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.lg, ...shadow },
  badge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, alignSelf: "flex-start" },
  badgeText: { fontSize: 12, fontWeight: "600" },
  avatar: { alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", gap: space.md, paddingVertical: 56, paddingHorizontal: space.xl },
  emptyIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  segmented: { flexDirection: "row", gap: 4, padding: 4, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  segment: { flex: 1, minHeight: 38, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  chip: { flexDirection: "row", gap: 6, alignItems: "center", minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.lineStrong },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: 10 },
  section: { color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, marginTop: space.xl, marginBottom: space.sm, marginHorizontal: space.lg },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg },
});
