import { useEffect } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, View } from "react-native";
import { router, usePathname } from "expo-router";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/ui";
import { parkDraft, useHeldItems, useRemaining, type HeldItem } from "@/lib/undo-send";
import { colors, radius, space } from "@/theme";

/**
 * Undo send on the phone: a bar above the tab bar for each held message, with a countdown,
 * Undo and Send now. Undo puts the message back into Compose exactly as it was.
 */
export function HeldSendBar() {
  const items = useHeldItems();
  const insets = useSafeAreaInsets();
  const path = usePathname();
  if (!items.length) return null;
  // Above the tab bar on the tab screens, at the bottom edge elsewhere.
  const onTabs = ["/today", "/inbox", "/chat", "/approvals", "/review", "/tasks", "/settings", "/more"].includes(path);
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: space.md, right: space.md, bottom: insets.bottom + (onTabs ? 58 : space.md), gap: space.sm }}>
      {items.map((it) => <HeldRow key={it.hold.id} item={it} />)}
    </View>
  );
}

function HeldRow({ item }: { item: HeldItem }) {
  const { hold, label } = item;
  const left = useRemaining(hold);
  const sending = hold.state() === "sending";
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`Message held for ${hold.seconds} seconds ${label}. Undo is available.`);
  }, [hold, label]);
  const undo = () => {
    if (!hold.undo()) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    parkDraft(item.draft);
    router.push({ pathname: "/compose", params: { restore: "1" } });
  };
  return (
    <View testID="held-send" accessibilityLiveRegion="polite"
      style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10, paddingLeft: space.md, paddingRight: 6, borderRadius: radius.lg,
        backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.lineStrong, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 16, shadowOffset: { width: 0, height: 6 }, elevation: 6 }}>
      <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.brandSoft }}>
        <Icon name="send" size={16} color={colors.brand} />
      </View>
      <View style={{ flex: 1 }} accessible accessibilityLabel={sending ? `Sending ${label}` : `Sends in ${left} seconds ${label}`}>
        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>{sending ? "Sending" : `Sending in ${left} s`}</Text>
        {label ? <Text style={{ color: colors.muted, fontSize: 13 }} numberOfLines={1}>{label}</Text> : null}
      </View>
      {!sending && (
        <>
          <Pressable onPress={() => void hold.sendNow()} accessibilityRole="button" accessibilityLabel="Send now" hitSlop={6}
            style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, backgroundColor: pressed ? colors.hover : "transparent" })}>
            <Icon name="send" size={18} color={colors.muted} />
          </Pressable>
          <Pressable testID="held-undo" onPress={undo} accessibilityRole="button" accessibilityLabel="Undo send" accessibilityHint="Opens the message again so you can change it"
            style={({ pressed }) => ({ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: radius.md, backgroundColor: pressed ? colors.hover : colors.brandSoft })}>
            <Icon name="undo" size={16} color={colors.brand} />
            <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Undo</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
