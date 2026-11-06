/**
 * M1 (1.10.9): small shared pieces for the Contacts, Visits, Mail merge, Mail archive and Sync screens.
 */
import { type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { colors, radius, space, TOUCH } from "@/theme";
import { Button, EmptyState, Icon, type IconName } from "./ui";
import { tr } from "@/i18n";

/** A search box in the app's style: 44 pt tall, a clear button, a label for screen readers. */
export function SearchBox({ value, onChange, label, placeholder, testID }: { value: string; onChange: (v: string) => void; label: string; placeholder: string; testID?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, paddingHorizontal: space.md, minHeight: TOUCH, borderRadius: radius.md, backgroundColor: colors.elevated }}>
      <Icon name="search" size={18} color={colors.subtle} />
      <TextInput
        value={value} onChangeText={onChange} placeholder={placeholder} placeholderTextColor={colors.subtle} accessibilityLabel={label}
        autoCapitalize="none" autoCorrect={false} returnKeyType="search" clearButtonMode="never" testID={testID}
        style={{ flex: 1, color: colors.fg, fontSize: 17, paddingVertical: 10 }}
      />
      {value ? (
        <Pressable onPress={() => onChange("")} accessibilityRole="button" accessibilityLabel={tr("m.today.clear_search")} hitSlop={10}
          style={{ minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" }} testID={testID ? `${testID}-clear` : undefined}>
          <Icon name="x" size={16} color={colors.subtle} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** The plain state for a 401 or 403: this account may not open it. */
export function NoAccess({ what }: { what: string }) {
  return <EmptyState icon="lock" title={tr("m.today.you_do_not_have_access_to_this")} body={tr("m.today.what_is_for_members_of_this_workspace_ask_an_adm", { what: what })} art={null} />;
}

/** Something went wrong loading: the server's words and a Try again button. */
export function LoadError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void }) {
  const msg = error instanceof Error && error.message ? error.message : tr("m.today.check_your_connection_and_try_again");
  return <EmptyState icon="alert-circle" title={title} body={msg} action={<Button label={tr("m.today.try_again")} variant="secondary" onPress={onRetry} />} art={null} />;
}

/** A small round icon button with a 44 pt target. */
export function SmallIconButton({ icon, label, onPress, disabled, testID, color }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; testID?: string; color?: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}
      style={({ pressed }) => ({ width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: TOUCH / 2, opacity: disabled ? 0.35 : 1, backgroundColor: pressed ? colors.hover : "transparent" })}>
      <Icon name={icon} size={18} color={color ?? colors.brand} />
    </Pressable>
  );
}

/** A footnote under a group, in the app's small grey type. */
export function Footnote({ children, testID }: { children: ReactNode; testID?: string }) {
  return <Text style={{ color: colors.subtle, fontSize: 13, lineHeight: 18, marginHorizontal: space.lg + space.lg }} testID={testID}>{children}</Text>;
}

/** A stat block: a big number over a small label. */
export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, minWidth: 70, gap: 2 }} accessible accessibilityLabel={`${label}, ${value}`}>
      <Text style={{ color: colors.fg, fontSize: 20, fontWeight: "600" }}>{value}</Text>
      <Text style={{ color: colors.subtle, fontSize: 13 }}>{label}</Text>
    </View>
  );
}
