import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { Tabs } from "expo-router";
import { Icon } from "@/components/ui";
import { useApprovals, useChatUnread, useNotificationCount, useOverview } from "@/lib/queries";
import { CommandSheet } from "@/components/command-sheet";
import { SyncPill, useCommandQueueRunner } from "@/components/sync-pill";
import { openCommandSheet } from "@/lib/command-sheet-store";
import { tick } from "@/lib/haptics";
import { notifyApprovals } from "@/lib/push";
import { FEATURES } from "@/config";
import { colors } from "@/theme";

export default function TabsLayout() {
  const pending = useApprovals("pending");
  const overview = useOverview();
  const unread = overview.data?.reduce((n, m) => n + (m.folders.inbox?.unread ?? 0), 0) ?? 0;
  const waiting = pending.data?.length ?? 0;
  const chat = useChatUnread();
  const chatUnread = chat.data?.total ?? 0;
  const chatMentions = chat.data?.mentions ?? 0;
  // R31: unread items in the Activity (triage) inbox.
  const activity = useNotificationCount().data ?? 0;
  // R33: offline edits wait in a command queue and sync when the connection is back.
  useCommandQueueRunner();

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
      tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.line },
      tabBarActiveTintColor: colors.brand, tabBarInactiveTintColor: colors.subtle,
      tabBarBadgeStyle: { backgroundColor: colors.bad, color: "#FFFFFF", fontWeight: "600", fontSize: 11 },
      sceneStyle: { backgroundColor: colors.bg },
    }}>
      <Tabs.Screen name="inbox" options={{ title: "Inbox", tabBarIcon: ({ color }) => <Icon name="inbox" color={color as string} />, tabBarBadge: unread || undefined, tabBarAccessibilityLabel: unread ? `Inbox, ${unread} unread` : "Inbox" }} />
      <Tabs.Screen name="approvals" options={{ title: "Approvals", tabBarIcon: ({ color }) => <Icon name="check-circle" color={color as string} />, tabBarBadge: waiting || undefined, tabBarAccessibilityLabel: waiting ? `Approvals, ${waiting} waiting` : "Approvals" }} />
      <Tabs.Screen name="chat" options={{ title: "Chat", tabBarIcon: ({ color }) => <Icon name="message-circle" color={color as string} />, tabBarBadge: chatUnread || undefined,
        tabBarAccessibilityLabel: chatUnread ? `Chat, ${chatUnread} unread${chatMentions ? `, ${chatMentions} ${chatMentions === 1 ? "mention" : "mentions"}` : ""}` : "Chat" }} />
      <Tabs.Screen name="activity" options={{ title: "Activity", tabBarIcon: ({ color }) => <Icon name="bell" color={color as string} />, tabBarBadge: activity || undefined,
        tabBarAccessibilityLabel: activity ? `Activity, ${activity} unread` : "Activity" }} />
      <Tabs.Screen name="tasks" options={{ title: "Tasks", href: FEATURES.tasks ? undefined : null, tabBarIcon: ({ color }) => <Icon name="check-square" color={color as string} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color }) => <Icon name="settings" color={color as string} /> }} />
    </Tabs>
    <SyncPill />
    <CommandSheet />
    </>
  );
}
