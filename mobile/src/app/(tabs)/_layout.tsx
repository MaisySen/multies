import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { Tabs } from "expo-router";
import { Icon } from "@/components/ui";
import { useQueryClient } from "@tanstack/react-query";
import { keys, useApprovals } from "@/lib/queries";
import { setAppBadge } from "@/lib/badges";
import { useBadges } from "@/lib/use-badges";
import { BarBlur, chrome, hasBarBlur, withAlpha } from "@/components/chrome";
import { CommandSheet } from "@/components/command-sheet";
import { SyncPill, useCommandQueueRunner } from "@/components/sync-pill";
import { openCommandSheet } from "@/lib/command-sheet-store";
import { tick } from "@/lib/haptics";
import { notifyApprovals } from "@/lib/push";
import { FEATURES } from "@/config";
import { colors } from "@/theme";
import { tr } from "@/i18n";
import { capBadge, groupCount } from "@/lib/numbers";
import { useQuickActions } from "@/lib/native-features";

export default function TabsLayout() {
  const pending = useApprovals("pending");
  const b = useBadges();
  const unread = b.inbox, waiting = b.approvals, chatUnread = b.chat, chatMentions = b.mentions, activity = b.activity;
  const due = FEATURES.tasks ? b.tasks : 0;
  const iconTotal = b.icon;
  useEffect(() => { setAppBadge(iconTotal); }, [iconTotal]);
  // R34: a push that arrives while the app is open refreshes the counts at once.
  const qc = useQueryClient();
  useEffect(() => {
    if (Platform.OS === "web") return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const N = require("expo-notifications") as typeof import("expo-notifications");
    const sub = N.addNotificationReceivedListener?.(() => { qc.invalidateQueries({ queryKey: keys.counts }); });
    return () => sub?.remove?.();
  }, [qc]);
  // R33: offline edits wait in a command queue and sync when the connection is back.
  useCommandQueueRunner();
  // R37: app icon quick actions (New task, Compose, Search, Inbox) on 1.10.0 builds.
  useQuickActions();

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
    <>
    <Tabs
      // R31: a long-press on any tab opens the command sheet.
      screenListeners={{ tabPress: () => { tick(); }, tabLongPress: () => { tick(); openCommandSheet(); } }}
      screenOptions={{
      headerShown: false,
      headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.fg, headerShadowVisible: false,
      // R34: translucent bar with a hairline edge. R37: real blur material on iOS 1.10.0 builds.
      tabBarStyle: hasBarBlur() ? { ...chrome.tabBar, backgroundColor: withAlpha(colors.surface, 0.55) } : chrome.tabBar,
      tabBarBackground: hasBarBlur() ? () => <BarBlur /> : undefined,
      tabBarLabelStyle: { fontSize: 10, fontWeight: "500", letterSpacing: 0.1 },
      tabBarActiveTintColor: colors.brand, tabBarInactiveTintColor: colors.subtle,
      tabBarBadgeStyle: { backgroundColor: colors.badge, color: "#FFFFFF", fontWeight: "600", fontSize: 11, fontVariant: ["tabular-nums"] },
      sceneStyle: { backgroundColor: colors.bg },
    }}>
      <Tabs.Screen name="today" options={{ title: tr("m.tabs.today"), tabBarIcon: ({ color, focused }) => <Icon name="today" size={25} filled={focused} color={color as string} />,
        tabBarBadge: capBadge(waiting) ?? undefined, tabBarAccessibilityLabel: waiting ? tr("m.tabs.today_approvals", { count: waiting }) : tr("m.tabs.today") }} />
      <Tabs.Screen name="inbox" options={{ title: tr("nav.inbox"), tabBarIcon: ({ color, focused }) => <Icon name="inbox" size={25} filled={focused} color={color as string} />, tabBarBadge: capBadge(unread) ?? undefined, tabBarAccessibilityLabel: unread ? tr("m.tabs.inbox_unread", { count: groupCount(unread) }) : tr("nav.inbox") }} />
      <Tabs.Screen name="approvals" options={{ title: tr("nav.approvals"), href: null, tabBarIcon: ({ color, focused }) => <Icon name="approvals" size={25} filled={focused} color={color as string} />, tabBarBadge: capBadge(waiting) ?? undefined, tabBarAccessibilityLabel: waiting ? tr("m.tabs.approvals_waiting", { count: waiting }) : tr("nav.approvals") }} />
      <Tabs.Screen name="chat" options={{ title: tr("nav.chat"), tabBarIcon: ({ color, focused }) => <Icon name="chat" size={25} filled={focused} color={color as string} />, tabBarBadge: capBadge(chatUnread) ?? undefined,
        tabBarAccessibilityLabel: chatUnread ? [tr("m.tabs.chat_unread", { count: groupCount(chatUnread) }), chatMentions ? tr("m.tabs.mentions", { count: chatMentions }) : ""].filter(Boolean).join(", ") : tr("nav.chat") }} />
      {/* M3 (1.10.11): five tabs. Activity is the same inbox as the bell on Today, so it left the bar (still a route for old links). */}
      <Tabs.Screen name="activity" options={{ title: tr("nav.activity"), href: null, tabBarIcon: ({ color, focused }) => <Icon name="bell" size={25} filled={focused} color={color as string} />, tabBarBadge: capBadge(activity) ?? undefined,
        tabBarAccessibilityLabel: activity ? tr("m.tabs.activity_unread", { count: groupCount(activity) }) : tr("nav.activity") }} />
      <Tabs.Screen name="tasks" options={{ title: tr("nav.tasks"), href: FEATURES.tasks ? undefined : null, tabBarIcon: ({ color, focused }) => <Icon name="tasks" size={25} filled={focused} color={color as string} />,
        tabBarBadge: capBadge(due) ?? undefined, tabBarAccessibilityLabel: due ? tr("m.tabs.tasks_due", { count: groupCount(due) }) : tr("nav.tasks") }} />
      {/* M2 (1.10.10): More (the web's menu sections as a grid) takes the last tab, as on the web for phones. Settings is a
          stack screen of its own (src/app/settings.tsx), opened from More > Settings or any link to /settings. */}
      <Tabs.Screen name="more" options={{ title: tr("nav.more"), tabBarIcon: ({ color, focused }) => <Icon name="more" size={25} filled={focused} color={color as string} />,
        tabBarAccessibilityLabel: tr("nav.more") }} />
    </Tabs>
    <SyncPill />
    <CommandSheet />
    </>
  );
}
