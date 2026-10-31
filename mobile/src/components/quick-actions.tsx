import { useEffect, useSyncExternalStore } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet, type SheetOption } from "./action-sheet";
import { Icon, type IconName } from "./ui";
import {
  clearQuickToast, closeQuickActions, currentQuickTarget, currentQuickToast, quickOptions, runQuickAction, subscribeQuickTarget, subscribeQuickToast,
  type QuickActionId,
} from "@/lib/quick-actions";
import { colors, radius, space } from "@/theme";

const ICON: Record<QuickActionId, IconName> = { open: "external-link", "open-link": "external-link", "copy-text": "copy", "copy-link": "link", share: "send", translate: "globe" };

/** 1.10.7: the one long press sheet for links, mail and posts (mounted once in the root layout). */
export function QuickActionsHost() {
  const t = useSyncExternalStore(subscribeQuickTarget, currentQuickTarget, currentQuickTarget);
  if (!t) return null;
  const options: SheetOption[] = quickOptions(t).map((o) => ({ id: o.id, label: o.label, icon: ICON[o.id] }));
  return (
    <ActionSheet visible title={t.title} subtitle={t.subtitle} options={options} testID="quick-actions"
      onClose={closeQuickActions}
      onSelect={(id) => { closeQuickActions(); void runQuickAction(id as QuickActionId, t); }} />
  );
}

/** The small "Copied" toast at the bottom of the screen (mounted once in the root layout). */
export function QuickToastHost() {
  const t = useSyncExternalStore(subscribeQuickToast, currentQuickToast, currentQuickToast);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!t) return;
    AccessibilityInfo.announceForAccessibility?.(t.text);
    const h = setTimeout(() => clearQuickToast(t.id), 2000);
    return () => clearTimeout(h);
  }, [t]);
  if (!t) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 96, alignItems: "center" }}>
      <View accessibilityLiveRegion="polite" testID="quick-toast"
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.fg, borderRadius: radius.pill, paddingHorizontal: space.lg, minHeight: 40, paddingVertical: space.sm, maxWidth: 340,
          shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 }}>
        <Icon name={t.tone === "ok" ? "check" : "alert-circle"} size={16} color={colors.bg} />
        <Text style={{ color: colors.bg, fontSize: 15, fontWeight: "600" }}>{t.text}</Text>
      </View>
    </View>
  );
}
