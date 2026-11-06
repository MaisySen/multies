import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { Banner, Button, EmptyState, IconButton, Loading } from "@/components/ui";
import { HiddenMessagesRow, PersonSafetySheet, useSafety } from "@/components/moderation";
import { canBlockAuthor, filterBlocked, userIdOf } from "@/lib/moderation";
import { groupMessages, type ChatItem } from "@/lib/chat-group";
import { ChatMessageRow, Composer, MessageMenu } from "@/components/chat";
import { useChannelMessages, useChatChannel, useChatPeople, useEarlierMessages, useMarkChannelRead, useMessageToTask, useSendChat } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { channelTitle, memberId } from "@/lib/chat";
import type { ChatMessage } from "@/api/types";
import { colors, font, space } from "@/theme";
import { tr } from "@/i18n";

/** One channel or DM: messages oldest first, kept fresh while open, marked read as you read. */
export default function ChannelScreen() {
  const { id, thread } = useLocalSearchParams<{ id: string; thread?: string }>();
  const { me, mode } = useSession();
  const meId = memberId(me?.user.id);
  const channel = useChatChannel(id);
  const feed = useChannelMessages(id);
  const people = useChatPeople();
  const send = useSendChat(id);
  const earlier = useEarlierMessages(id);
  const markRead = useMarkChannelRead();
  const toTask = useMessageToTask();
  const offline = useOffline();
  const focused = useIsFocused();
  const [menu, setMenu] = useState<ChatMessage | null>(null);
  const [personMenu, setPersonMenu] = useState(false);
  const safety = useSafety();
  const list = useRef<FlatList<ChatItem>>(null);

  // A push or notification for a reply opens the channel, then the thread on top.
  const openedThread = useRef(false);
  useEffect(() => {
    if (thread && !openedThread.current) { openedThread.current = true; router.push({ pathname: "/chat/thread/[id]", params: { id: thread } }); }
  }, [thread]);

  // Mark read on open, and again whenever a new message arrives while the channel is on screen.
  const all = feed.data?.messages ?? [];
  // R35: messages from people you blocked never show, even from the cache or an older server.
  const { messages, hidden } = filterBlocked(all, safety.blocked);
  const items = useMemo(() => groupMessages(messages), [messages]);
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (focused && id && lastId) markRead.mutate({ id, messageId: lastId });
  }, [focused, id, lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openThread = (m: ChatMessage) => router.push({ pathname: "/chat/thread/[id]", params: { id: m.id } });
  const makeTask = (m: ChatMessage) => toTask.mutate({ messageId: m.id }, {
    onSuccess: ({ task }) => { setMenu(null); router.push({ pathname: "/task/[id]", params: { id: task.id } }); },
  });

  const title = channel.data ? channelTitle(channel.data) : "";
  const isDm = channel.data?.kind === "dm";
  const context = isDm ? "dm" as const : "chat" as const;
  // In a one to one DM, the header menu offers Block or Unblock and Report for the other person.
  const others = isDm ? (channel.data?.members ?? []).filter((x) => x.id !== meId && userIdOf(x.id) !== userIdOf(meId)) : [];
  const other = others.length === 1 ? { userId: others[0].id, name: others[0].name } : null;
  const otherBlocked = other ? safety.isBlocked(other.userId) : false;
  const screenOptions = { title, headerRight: other ? () => <IconButton icon="more" label={tr("m.chat.more_for_name", { name: other.name })} onPress={() => setPersonMenu(true)} testID="dm-more" /> : undefined };
  if (feed.isPending) return <><Stack.Screen options={{ title }} /><Loading variant="chat" label={tr("m.chat.loading_messages")} /></>;
  if (feed.error) return <EmptyState icon="alert-circle" title={tr("m.chat.couldn_t_load_messages")} body={feed.error.message} action={<Button label={tr("m.chat.try_again")} variant="secondary" onPress={() => feed.refetch()} />} />;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={screenOptions} />
      {offline ? <Banner text={tr("m.chat.you_re_offline_new_messages_will_show_when_you_r")} /> : null}
      {toTask.error ? <Banner tone="bad" icon="alert-circle" text={tr("m.chat.couldn_t_make_the_task_message", { message: toTask.error.message })} /> : null}
      <FlatList
        ref={list}
        testID="chat-messages"
        data={items}
        keyExtractor={(it) => it.id}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: space.sm }}>
            {channel.data?.topic ? <Text style={font.small}>{channel.data.topic}</Text> : null}
            {hidden ? <HiddenMessagesRow /> : null}
            {feed.data?.hasMore ? <Button label={tr("m.chat.show_earlier_messages")} variant="ghost" loading={earlier.isPending} onPress={() => earlier.mutate()} testID="earlier" /> : null}
          </View>
        }
        ListEmptyComponent={hidden ? undefined : <EmptyState icon="message-circle" title={tr("m.chat.no_messages_yet")} body={tr("m.chat.say_hello_type_to_mention_someone")} />}
        renderItem={({ item }) => item.kind === "day" ? <DayLine label={item.label} />
          : <ChatMessageRow m={item.m} grouped={item.grouped} meId={meId} sample={mode === "sample"} onLongPress={setMenu} onOpenThread={openThread} />}
      />
      {otherBlocked ? (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.line, padding: space.lg, gap: space.sm, alignItems: "center" }} testID="dm-blocked-bar">
          <Text style={font.small}>{tr("m.chat.you_blocked_name_you_won_t_see_their_messages", { name: other?.name ?? "them" })}</Text>
          <Button label={tr("m.chat.unblock")} variant="secondary" onPress={() => other && safety.unblock(other.userId)} testID="dm-unblock" />
        </View>
      ) : (
        <Composer people={people.data ?? []} placeholder={title ? tr("m.chat.message_title", { title: title }) : tr("m.chat.message")} sending={send.isPending}
          onSend={(body, files, onProgress) => send.mutateAsync({ body, attachments: files, onProgress })} />
      )}
      <MessageMenu m={menu} onClose={() => setMenu(null)} onReply={openThread} onMakeTask={makeTask} busy={toTask.isPending}
        onReport={(m) => safety.startReport({ targetType: "message", messageId: m.id, userId: m.author.id, name: m.author.name, context, canBlock: canBlockAuthor(m, meId) })}
        onBlock={menu && canBlockAuthor(menu, meId) ? (m) => safety.askBlock({ userId: m.author.id, name: m.author.name }) : undefined} />
      <PersonSafetySheet person={other} visible={personMenu} onClose={() => setPersonMenu(false)} safety={safety} context="dm" />
      {safety.ui}
    </KeyboardAvoidingView>
  );
}

/** R35: the day line between days, centred and quiet like a native messenger. */
function DayLine({ label }: { label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs }} accessibilityRole="header" testID={`day-${label}`}>
      <View style={{ flex: 1, height: 0.5, backgroundColor: colors.line }} />
      <Text style={{ color: colors.subtle, fontSize: 12, fontWeight: "600" }}>{label}</Text>
      <View style={{ flex: 1, height: 0.5, backgroundColor: colors.line }} />
    </View>
  );
}
