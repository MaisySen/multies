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
      screenListeners={{ tabLongPress: () => { tick(); openCommandSheet(); } }}
      screenOptions={{
      headerShown: false,
      headerStyle: { backgroundColor: colors.bg }, headerTintColor: colors.fg, headerShadowVisible: false,
      // R34: translucent bar with a hairline edge. R37: real blur material on iOS 1.10.0 builds.
      tabBarStyle: hasBarBlur() ? { ...chrome.tabBar, backgroundColor: withAlpha(colors.surface, 0.55) } : chrome.tabBar,
      tabBarBackground: hasBarBlur() ? () => <BarBlur /> : undefined,
      tabBarLabelStyle: { fontSize: 10, fontWeight: "500", letterSpacing: 0.1 },
      tabBarActiveTintColor: colors.brand, tabBarInactiveTintColor: colors.subtle,
      tabBarBadgeStyle: { backgroundColor: colors.bad, color: "#FFFFFF", fontWeight: "600", fontSize: 11 },
      sceneStyle: { backgroundColor: colors.bg },
    }}>
      <Tabs.Screen name="today" options={{ title: "Today", tabBarIcon: ({ color, focused }) => <Icon name="today" size={25} filled={focused} color={color as string} />,
        tabBarBadge: waiting || undefined, tabBarAccessibilityLabel: waiting ? `Today, ${waiting} approvals waiting` : "Today" }} />
      <Tabs.Screen name="inbox" options={{ title: "Inbox", tabBarIcon: ({ color, focused }) => <Icon name="inbox" size={25} filled={focused} color={color as string} />, tabBarBadge: unread || undefined, tabBarAccessibilityLabel: unread ? `Inbox, ${unread} unread` : "Inbox" }} />
      <Tabs.Screen name="approvals" options={{ title: "Approvals", href: null, tabBarIcon: ({ color, focused }) => <Icon name="approvals" size={25} filled={focused} color={color as string} />, tabBarBadge: waiting || undefined, tabBarAccessibilityLabel: waiting ? `Approvals, ${waiting} waiting` : "Approvals" }} />
      <Tabs.Screen name="chat" options={{ title: "Chat", tabBarIcon: ({ color, focused }) => <Icon name="chat" size={25} filled={focused} color={color as string} />, tabBarBadge: chatUnread || undefined,
        tabBarAccessibilityLabel: chatUnread ? `Chat, ${chatUnread} unread${chatMentions ? `, ${chatMentions} ${chatMentions === 1 ? "mention" : "mentions"}` : ""}` : "Chat" }} />
      <Tabs.Screen name="activity" options={{ title: "Activity", tabBarIcon: ({ color, focused }) => <Icon name="bell" size={25} filled={focused} color={color as string} />, tabBarBadge: activity || undefined,
        tabBarAccessibilityLabel: activity ? `Activity, ${activity} unread` : "Activity" }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", href: FEATURES.tasks ? undefined : null, tabBarIcon: ({ color, focused }) => <Icon name="tasks" size={25} filled={focused} color={color as string} />,
        tabBarBadge: due || undefined, tabBarAccessibilityLabel: due ? `Tasks, ${due} due today or overdue` : "Tasks" }} />
      {/* M2 (1.10.10): More (the web's menu sections as a grid) takes the last tab, as on the web for phones. Settings is a
          stack screen of its own (src/app/settings.tsx), opened from More > Settings or any link to /settings. */}
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: ({ color, focused }) => <Icon name="more" size={25} filled={focused} color={color as string} />,
        tabBarAccessibilityLabel: "More" }} />
    </Tabs>
    <SyncPill />
    <CommandSheet />
    </>
  );
}
