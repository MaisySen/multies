import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { Banner, Button, Chip, EmptyState, Icon, Loading } from "@/components/ui";
import { useNotifications, useReadNotifications } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { API_BASE } from "@/config";
import { timeAgo } from "@/lib/format";
import { NOTIFICATION_FILTERS, categoryIcon, notificationTarget, sortNotifications } from "@/lib/notifications";
import type { AppNotification } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/** One place for mentions, assignments, comments, approvals, due dates and chat. */
export default function Notifications() {
  const [filter, setFilter] = useState("all");
  const q = useNotifications(filter);
  const all = useNotifications("all");
  const read = useReadNotifications();
  const offline = useOffline();
  const counts = all.data?.counts ?? {};
  const unread = all.data?.unread ?? 0;
  const category = NOTIFICATION_FILTERS.find((f) => f.id === filter)?.category;

  const open = (n: AppNotification) => {
    if (!n.read) read.mutate({ ids: [n.id] });
    const target = notificationTarget(n, API_BASE);
    if (target.kind === "route") router.push(target.href as never);
    else if (target.kind === "web") WebBrowser.openBrowserAsync(target.url).catch(() => {});
  };

  const list = q.data ? sortNotifications(q.data.notifications) : [];
  const anyUnread = category ? (counts[category] ?? 0) > 0 : unread > 0;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl * 2 }} testID="notifications"
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); all.refetch(); }} />}>
      {offline ? <Banner text="You're offline. These are the notifications saved on this phone." /> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md }}>
        {NOTIFICATION_FILTERS.map((f) => (
          <Chip key={f.id} label={f.label} selected={filter === f.id} onPress={() => setFilter(f.id)} count={f.category ? counts[f.category] || undefined : unread || undefined} />
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <Text style={font.small}>{unread ? `${unread} unread` : "All caught up"}</Text>
        <Button label="Mark all read" variant="ghost" icon="check" disabled={!anyUnread} onPress={() => read.mutate(category ? { category } : {})} testID="mark-all-read" />
      </View>
      {q.isPending ? <Loading /> : q.error ? (
        <EmptyState icon="alert-circle" title="Couldn't load notifications" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />
      ) : list.length ? list.map((n) => <NotificationRow key={n.id} n={n} onPress={() => open(n)} />) : (
        <EmptyState icon="bell" title="Nothing here" body={filter === "all" ? "Mentions, assignments, comments, approvals and due dates show up here." : "Nothing in this filter yet."} />
      )}
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg }}>
        <Button label="Notification settings" icon="sliders" variant="secondary" onPress={() => router.push("/notification-settings")} testID="open-notification-settings" />
      </View>
    </ScrollView>
  );
}

function NotificationRow({ n, onPress }: { n: AppNotification; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${n.read ? "" : "Unread. "}${n.title}, ${timeAgo(n.createdAt)}`} testID={`notification-${n.id}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 64, paddingHorizontal: space.lg, paddingVertical: space.sm,
        backgroundColor: pressed ? colors.hover : n.read ? "transparent" : colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line })}>
      <View style={{ width: 8, alignItems: "center" }}>
        {n.read ? null : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand }} testID={`unread-dot-${n.id}`} />}
      </View>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, backgroundColor: n.read ? colors.elevated : colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
        <Icon name={categoryIcon(n.category)} size={17} color={n.read ? colors.muted : colors.brand} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: n.read ? colors.muted : colors.fg, fontSize: 15, fontWeight: n.read ? "400" : "600" }} numberOfLines={2}>{n.title}</Text>
        <Text style={font.tiny}>{timeAgo(n.createdAt)}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.subtle} />
    </Pressable>
  );
}
