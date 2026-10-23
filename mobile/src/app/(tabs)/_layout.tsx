import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { Tabs } from "expo-router";
import { Icon } from "@/components/ui";
import { useApprovals, useOverview } from "@/lib/queries";
import { notifyApprovals } from "@/lib/push";
import { FEATURES } from "@/config";
import { colors } from "@/theme";

export default function TabsLayout() {
  const pending = useApprovals("pending");
  const overview = useOverview();
  const unread = overview.data?.reduce((n, m) => n + (m.folders.inbox?.unread ?? 0), 0) ?? 0;
  const waiting = pending.data?.length ?? 0;

  // A local alert when a new approval arrives while the app is in the background but still alive.
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!pending.data) return;
    const ids = new Set(pending.data.map((a) => a.id));
    if (seen.current && AppState.currentState !== "active") {
      const fresh = pending.data.filter((a) => !seen.current!.has(a.id));
      if (fresh.length) notifyApprovals(fresh.length, fresh[0].subject).catch(() => {});
    }
    seen.current = ids;
  }, [pending.data]);

  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.fg, headerShadowVisible: false,
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
      tabBarActiveTintColor: colors.brand, tabBarInactiveTintColor: colors.subtle,
      tabBarBadgeStyle: { backgroundColor: colors.brand, color: colors.brandFg, fontWeight: "700" },
      sceneStyle: { backgroundColor: colors.bg },
    }}>
      <Tabs.Screen name="inbox" options={{ title: "Inbox", tabBarIcon: ({ color }) => <Icon name="inbox" color={color as string} />, tabBarBadge: unread || undefined, tabBarAccessibilityLabel: unread ? `Inbox, ${unread} unread` : "Inbox" }} />
      <Tabs.Screen name="approvals" options={{ title: "Approvals", tabBarIcon: ({ color }) => <Icon name="check-circle" color={color as string} />, tabBarBadge: waiting || undefined, tabBarAccessibilityLabel: waiting ? `Approvals, ${waiting} waiting` : "Approvals" }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", href: FEATURES.tasks ? undefined : null, tabBarIcon: ({ color }) => <Icon name="check-square" color={color as string} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color }) => <Icon name="settings" color={color as string} /> }} />
    </Tabs>
  );
}
