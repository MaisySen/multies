/** M3 (1.10.11): small shared pieces for the new native screens: a progress bar, a problem state and a list header. */
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, Icon } from "@/components/ui";
import { noAccess } from "@/lib/contacts-queries";
import { colors, font, radius, space } from "@/theme";
import { tr } from "@/i18n";

export function ProgressBar({ value, tone = "brand", label }: { value: number; tone?: "brand" | "ok" | "warn" | "bad"; label?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const fill = tone === "ok" ? colors.ok : tone === "warn" ? colors.warn : tone === "bad" ? colors.bad : colors.brand;
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityValue={{ min: 0, max: 100, now: v }}
      style={{ height: 6, borderRadius: radius.pill, backgroundColor: colors.elevated, overflow: "hidden" }}>
      <View style={{ width: `${v}%`, height: 6, borderRadius: radius.pill, backgroundColor: fill }} />
    </View>
  );
}

export function Problem({ q, what, testID }: { q: { error: unknown; refetch: () => unknown }; what: string; testID: string }) {
  const denied = noAccess(q.error);
  return (
    <EmptyState icon={denied ? "lock" : "alert-circle"} title={denied ? tr("m.common.what_aren_t_open_to_you", { what: what }) : tr("m.common.couldn_t_load_tolowercase", { toLowerCase: what.toLowerCase() })}
      body={denied ? tr("m.common.ask_an_admin_of_this_workspace_for_access") : tr("m.common.check_your_connection_and_try_again")}
      action={denied ? undefined : <Button label={tr("m.common.retry")} onPress={() => q.refetch()} testID={`${testID}-retry`} />} />
  );
}

export function ListHeader({ title, right }: { title: string; right?: string }) {
  return (
    <View accessibilityRole="header" style={{ flexDirection: "row", justifyContent: "space-between", paddingTop: space.lg, paddingBottom: space.xs, paddingHorizontal: space.xs }}>
      <Text style={[font.tiny, { fontWeight: "600", color: colors.muted }]}>{title.toUpperCase()}</Text>
      {right ? <Text style={[font.tiny, { color: colors.muted }]}>{right}</Text> : null}
    </View>
  );
}

/** True when this screen was pushed (there is a screen to go back to). A cold open from a link or a push has none. */
function canGoBack(): boolean {
  try { return typeof router.canGoBack === "function" ? router.canGoBack() : true; } catch { return true; }
}

/**
 * M3 (1.10.11): one header for app screens pushed over the tabs, the same on iPhone, Android and the web build: a back
 * chevron (or Home when the screen was opened straight from a link or a notification, so there is always a way out),
 * then the large title in the same type as the tab screens (Mail, More). Swipe back still works on iPhone.
 */
export function ScreenHeader({ title, right, back = tr("m.common.back"), testID }: { title: string; right?: ReactNode; back?: string; testID?: string }) {
  const insets = useSafeAreaInsets();
  const pushed = canGoBack();
  return (
    <>
      <Stack.Screen options={{ headerShown: false, title }} />
      <View style={{ paddingTop: insets.top, backgroundColor: colors.bg }} testID={testID ?? "screen-header"}>
        <View style={{ minHeight: 44, flexDirection: "row", alignItems: "center", paddingHorizontal: space.xs }}>
          <Pressable testID="screen-back" accessibilityRole="button" accessibilityLabel={pushed ? tr("m.common.back_to_back", { back: back === "Back" ? "the previous screen" : back }) : tr("m.common.go_to_today")}
            onPress={() => { if (pushed) router.back(); else router.replace("/today"); }} hitSlop={8}
            style={({ pressed }) => ({ minHeight: 44, minWidth: 44, flexDirection: "row", alignItems: "center", gap: 2, paddingRight: space.sm, opacity: pressed ? 0.5 : 1 })}>
            <Icon name={pushed ? "chevron-left" : "home"} size={pushed ? 26 : 20} color={colors.brand} />
            <Text style={{ color: colors.brand, fontSize: 17, marginLeft: pushed ? 0 : 4 }}>{pushed ? back : tr("m.common.today")}</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {right ? <View style={{ flexDirection: "row", alignItems: "center", paddingRight: space.sm }}>{right}</View> : null}
        </View>
        <Text style={[font.largeTitle, { paddingHorizontal: space.lg, paddingBottom: space.sm }]} accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{title}</Text>
      </View>
    </>
  );
}
