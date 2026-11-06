/** MPAR3: small shared pieces for the Calendar, meeting notes, compose extras and shared inbox screens. */
import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReduceMotion } from "@/lib/motion";
import { Icon, type IconName } from "./ui";
import { colors, font, lh, radius, space, TOUCH } from "@/theme";
import { tr } from "@/i18n";

/** A bottom sheet that scrolls and stays above the keyboard; for short forms (add event, send later, send securely). */
export function Sheet({ visible, title, subtitle, onClose, children, footer, testID }: {
  visible: boolean; title: string; subtitle?: string | null; onClose: () => void; children: ReactNode; footer?: ReactNode; testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  return (
    <Modal visible={visible} transparent animationType={reduce ? "none" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "flex-end" }}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={tr("m.m3x.close_sheet")} accessibilityRole="button">
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)" }} />
        </Pressable>
        <View testID={testID} accessibilityViewIsModal style={[st.sheet, { paddingBottom: insets.bottom + space.md }]}>
          <View style={{ alignItems: "center", paddingTop: space.sm }}><View style={st.grabber} /></View>
          <View style={st.head}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={st.title} accessibilityRole="header" numberOfLines={2}>{title}</Text>
              {subtitle ? <Text style={st.sub} numberOfLines={3}>{subtitle}</Text> : null}
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={tr("common.cancel")} testID={testID ? `${testID}-close` : undefined}
              style={({ pressed }) => [st.close, pressed && { opacity: 0.6 }]} hitSlop={4}>
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md }}>
            {children}
          </ScrollView>
          {footer ? <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm }}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A choice pill with a full 44 point tap target. */
export function Pill({ label, selected, onPress, icon, testID, color }: { label: string; selected?: boolean; onPress: () => void; icon?: IconName; testID?: string; color?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!selected }} accessibilityLabel={label} testID={testID}
      style={({ pressed }) => [st.pill, selected ? { backgroundColor: colors.brandFill, borderColor: colors.brandFill } : { backgroundColor: colors.surface, borderColor: colors.line }, pressed && { opacity: 0.75 }]}>
      {color ? <View style={[st.swatch, { backgroundColor: color, opacity: selected ? 1 : 0.35 }]} /> : null}
      {icon ? <Icon name={icon} size={16} color={selected ? colors.brandFg : colors.muted} /> : null}
      <Text style={[st.pillText, { color: selected ? colors.brandFg : colors.fg }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** A row of sheet actions: full width, 48 points tall. */
export function SheetAction({ icon, label, onPress, destructive, testID, disabled }: { icon: IconName; label: string; onPress: () => void; destructive?: boolean; testID?: string; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}
      style={({ pressed }) => [st.action, pressed && { backgroundColor: colors.hover }, disabled && { opacity: 0.45 }]}>
      <Icon name={icon} size={20} color={destructive ? colors.bad : colors.brand} />
      <Text style={{ flex: 1, color: destructive ? colors.bad : colors.fg, fontSize: 16, lineHeight: lh(21) }}>{label}</Text>
    </Pressable>
  );
}

/** A small label above a group of fields. */
export function Label({ children, nativeID }: { children: string; nativeID?: string }) {
  return <Text nativeID={nativeID} style={{ color: colors.muted, fontSize: 14, fontWeight: "500", lineHeight: lh(19) }}>{children}</Text>;
}

/** A plain note under a form. */
export function Note({ children, tone }: { children: string; tone?: "bad" | "ok" }) {
  return <Text style={[font.tiny, { lineHeight: lh(17), fontSize: 13, color: tone === "bad" ? colors.bad : tone === "ok" ? colors.ok : colors.subtle }]} accessibilityRole={tone === "bad" ? "alert" : undefined}>{children}</Text>;
}

export const st = StyleSheet.create({
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, maxHeight: "88%" },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.line },
  head: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
  title: { color: colors.fg, fontSize: 17, fontWeight: "700", lineHeight: lh(22) },
  sub: { color: colors.subtle, fontSize: 13, lineHeight: lh(18) },
  close: { width: TOUCH, height: TOUCH, marginTop: -10, marginRight: -10, alignItems: "center", justifyContent: "center", borderRadius: TOUCH / 2 },
  pill: { minHeight: TOUCH, minWidth: TOUCH, justifyContent: "center", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: TOUCH / 2, borderWidth: StyleSheet.hairlineWidth },
  pillText: { fontSize: 14, fontWeight: "600", lineHeight: lh(19), flexShrink: 1 },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  action: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.sm, borderRadius: radius.md },
});
