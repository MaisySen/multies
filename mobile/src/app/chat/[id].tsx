import { useEffect, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Text, View } from "react-native";
import { router, Stack, useIsFocused, useLocalSearchParams } from "expo-router";
import { Banner, Button, EmptyState, Loading } from "@/components/ui";
import { ChatMessageRow, Composer, MessageMenu } from "@/components/chat";
import { useChannelMessages, useChatChannel, useChatPeople, useEarlierMessages, useMarkChannelRead, useMessageToTask, useSendChat } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { channelTitle, memberId } from "@/lib/chat";
import type { ChatMessage } from "@/api/types";
import { colors, font, space } from "@/theme";

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
  const list = useRef<FlatList<ChatMessage>>(null);

  // A push or notification for a reply opens the channel, then the thread on top.
  const openedThread = useRef(false);
  useEffect(() => {
    if (thread && !openedThread.current) { openedThread.current = true; router.push({ pathname: "/chat/thread/[id]", params: { id: thread } }); }
  }, [thread]);

  // Mark read on open, and again whenever a new message arrives while the channel is on screen.
  const messages = feed.data?.messages ?? [];
  const lastId = messages[messages.length - 1]?.id;
  useEffect(() => {
    if (focused && id && lastId) markRead.mutate({ id, messageId: lastId });
  }, [focused, id, lastId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openThread = (m: ChatMessage) => router.push({ pathname: "/chat/thread/[id]", params: { id: m.id } });
  const makeTask = (m: ChatMessage) => toTask.mutate({ messageId: m.id }, {
    onSuccess: ({ task }) => { setMenu(null); router.push({ pathname: "/task/[id]", params: { id: task.id } }); },
  });

  const title = channel.data ? channelTitle(channel.data) : "";
  if (feed.isPending) return <><Stack.Screen options={{ title }} /><Loading /></>;
  if (feed.error) return <EmptyState icon="alert-circle" title="Couldn't load messages" body={feed.error.message} action={<Button label="Try again" variant="secondary" onPress={() => feed.refetch()} />} />;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title }} />
      {offline ? <Banner text="You're offline. New messages will show when you're back." /> : null}
      {toTask.error ? <Banner tone="bad" icon="alert-circle" text={`Couldn't make the task: ${toTask.error.message}`} /> : null}
      <FlatList
        ref={list}
        testID="chat-messages"
        data={messages}
        keyExtractor={(m) => m.id}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.sm, gap: space.sm }}>
            {channel.data?.topic ? <Text style={font.small}>{channel.data.topic}</Text> : null}
            {feed.data?.hasMore ? <Button label="Show earlier messages" variant="ghost" loading={earlier.isPending} onPress={() => earlier.mutate()} testID="earlier" /> : null}
          </View>
        }
        ListEmptyComponent={<EmptyState icon="message-circle" title="No messages yet" body="Say hello. Type @ to mention someone." />}
        renderItem={({ item }) => <ChatMessageRow m={item} meId={meId} sample={mode === "sample"} onLongPress={setMenu} onOpenThread={openThread} />}
      />
      <Composer people={people.data ?? []} placeholder={title ? `Message ${title}` : "Message"} sending={send.isPending}
        onSend={(body, files, onProgress) => send.mutateAsync({ body, attachments: files, onProgress })} />
      <MessageMenu m={menu} onClose={() => setMenu(null)} onReply={openThread} onMakeTask={makeTask} busy={toTask.isPending} />
    </KeyboardAvoidingView>
  );
}
