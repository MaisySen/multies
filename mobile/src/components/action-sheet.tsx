import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReduceMotion } from "@/lib/motion";
import { Icon, type IconName } from "./ui";
import { colors, radius, space, TOUCH } from "@/theme";

export interface SheetOption { id: string; label: string; icon?: IconName; hint?: string; destructive?: boolean; selected?: boolean }

/**
 * R31: a bottom sheet of choices, used by the long-press menus, the snooze picker and the task
 * field pickers. Tapping outside or Cancel closes it. Plain React Native (no native module).
 */
export function ActionSheet({ visible, title, subtitle, options, onSelect, onClose, testID, children }: {
  visible: boolean; title: string; subtitle?: string; options: SheetOption[]; onSelect: (id: string) => void; onClose: () => void; testID?: string; children?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  return (
    <Modal visible={visible} transparent animationType={reduce ? "none" : "slide"} onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)" }} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
      <View testID={testID} accessibilityViewIsModal
        style={{ backgroundColor: colors.surface, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, paddingBottom: insets.bottom + space.sm, maxHeight: "80%" }}>
        <View style={{ alignItems: "center", paddingTop: space.sm }}><View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: colors.line }} /></View>
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm, gap: 2 }}>
          <Text style={{ color: colors.fg, fontSize: 17, fontWeight: "700" }} accessibilityRole="header" numberOfLines={2}>{title}</Text>
          {subtitle ? <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={2}>{subtitle}</Text> : null}
        </View>
        {children}
        <ScrollView contentContainerStyle={{ paddingBottom: space.sm }}>
          {options.map((o) => (
            <Pressable key={o.id} onPress={() => onSelect(o.id)} accessibilityRole="button" accessibilityLabel={o.hint ? `${o.label}, ${o.hint}` : o.label}
              accessibilityState={{ selected: !!o.selected }} testID={`sheet-${o.id}`}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TOUCH + 6, paddingHorizontal: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
              {o.icon ? <Icon name={o.icon} size={20} color={o.destructive ? colors.bad : colors.brand} /> : null}
              <Text style={{ flex: 1, color: o.destructive ? colors.bad : colors.fg, fontSize: 16 }} numberOfLines={1}>{o.label}</Text>
              {o.hint ? <Text style={{ color: colors.subtle, fontSize: 13 }}>{o.hint}</Text> : null}
              {o.selected ? <Icon name="check" size={18} color={colors.brand} /> : null}
            </Pressable>
          ))}
        </ScrollView>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Cancel" testID="sheet-cancel"
          style={({ pressed }) => ({ marginHorizontal: space.lg, marginTop: space.xs, minHeight: TOUCH + 4, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? colors.hover : colors.elevated })}>
          <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
