import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { Avatar, Banner, Button, EmptyState, Icon, IconButton, Loading, SectionTitle } from "@/components/ui";
import { NotificationBell } from "@/components/notification-bell";
import { useChatChannels } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { channelTitle, groupChannels, messageTime } from "@/lib/chat";
import type { ChatChannel } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/** Team chat: channels first, then direct messages, with unread and mention counts. */
export default function Chat() {
  const q = useChatChannels();
  const offline = useOffline();
  const { mode } = useSession();
  const header = <Stack.Screen options={{ headerRight: () => (
    <View style={{ flexDirection: "row" }}>
      <NotificationBell />
      <IconButton icon="edit" label="New message" onPress={() => router.push("/chat/new")} testID="new-dm" />
    </View>
  ) }} />;
  if (q.isPending) return <>{header}<Loading /></>;
  if (q.error) return <>{header}<EmptyState icon="alert-circle" title="Couldn't load chat" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} /></>;
  const { channels, dms } = groupChannels(q.data);
  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: space.xxl * 2 }} testID="chat-list"
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />}>
      {header}
      {offline ? <Banner text="You're offline. This is the chat list saved on this phone." /> : null}
      {mode === "sample" ? <Text style={[font.tiny, { marginHorizontal: space.lg, marginTop: space.md }]}>Sample workspace. Messages you send stay on this phone.</Text> : null}
      <SectionTitle>Channels</SectionTitle>
      {channels.length ? channels.map((c) => <ChannelRow key={c.id} c={c} />) : <Text style={[font.small, { marginHorizontal: space.lg }]}>No channels yet. Make one on the web.</Text>}
      <SectionTitle>Direct messages</SectionTitle>
      {dms.length ? dms.map((c) => <ChannelRow key={c.id} c={c} />) : (
        <Text style={[font.small, { marginHorizontal: space.lg }]}>No direct messages yet.</Text>
      )}
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg }}>
        <Button label="New message" icon="edit" variant="secondary" onPress={() => router.push("/chat/new")} testID="new-dm-button" />
      </View>
    </ScrollView>
  );
}

function ChannelRow({ c }: { c: ChatChannel }) {
  const unread = c.unread > 0;
  const title = channelTitle(c);
  const label = [title, unread ? `${c.unread} unread` : null, c.mentions ? `${c.mentions} ${c.mentions === 1 ? "mention" : "mentions"}` : null].filter(Boolean).join(", ");
  return (
    <Pressable onPress={() => router.push({ pathname: "/chat/[id]", params: { id: c.id } })} accessibilityRole="button" accessibilityLabel={label} testID={`channel-${c.id}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 60, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: pressed ? colors.hover : "transparent" })}>
      {c.kind === "dm" ? <Avatar name={c.name} size={36} /> : (
        <View style={{ width: 36, height: 36, borderRadius: radius.md, backgroundColor: colors.elevated, alignItems: "center", justifyContent: "center" }}>
          <Icon name={c.private ? "lock" : "hash"} size={17} color={unread ? colors.fg : colors.muted} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <Text style={{ flex: 1, color: unread ? colors.fg : colors.muted, fontSize: 16, fontWeight: unread ? "700" : "500" }} numberOfLines={1}>{c.kind === "dm" ? c.name : c.name}</Text>
          {c.lastMessageAt ? <Text style={font.tiny}>{messageTime(c.lastMessageAt)}</Text> : null}
        </View>
        {c.lastMessage ? (
          <Text style={{ color: unread ? colors.muted : colors.subtle, fontSize: 14 }} numberOfLines={1}>
            {c.kind === "channel" ? `${c.lastMessage.authorName}: ` : ""}{c.lastMessage.preview}
          </Text>
        ) : c.topic ? <Text style={{ color: colors.subtle, fontSize: 14 }} numberOfLines={1}>{c.topic}</Text> : null}
      </View>
      {c.mentions ? (
        <View style={{ minWidth: 30, height: 22, borderRadius: 11, paddingHorizontal: 7, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" }} testID={`mentions-${c.id}`}>
          <Text style={{ color: colors.brandFg, fontWeight: "700", fontSize: 12 }}>@{c.mentions}</Text>
        </View>
      ) : unread ? (
        <View style={{ minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" }} testID={`unread-${c.id}`}>
          <Text style={{ color: colors.fg, fontWeight: "700", fontSize: 12 }}>{c.unread}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}
