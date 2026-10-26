import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Banner, Button, EmptyState, Loading } from "@/components/ui";
import { ChatMessageRow, Composer, MessageMenu } from "@/components/chat";
import { useChatPeople, useChatThread, useMessageToTask, useSendChat } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { memberId } from "@/lib/chat";
import { filterBlocked, canBlockAuthor } from "@/lib/moderation";
import { GROUP_GAP_MS } from "@/lib/chat-group";
import { HiddenMessagesRow, useSafety } from "@/components/moderation";
import type { ChatMessage } from "@/api/types";
import { colors, font, space } from "@/theme";

/** A message and its replies, with a box to reply in the thread. */
export default function ChatThread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me, mode } = useSession();
  const meId = memberId(me?.user.id);
  const q = useChatThread(id);
  const people = useChatPeople();
  const send = useSendChat(q.data?.message.channelId ?? "");
  const toTask = useMessageToTask();
  const [menu, setMenu] = useState<ChatMessage | null>(null);
  const safety = useSafety();
  const makeTask = (m: ChatMessage) => toTask.mutate({ messageId: m.id }, {
    onSuccess: ({ task }) => { setMenu(null); router.push({ pathname: "/task/[id]", params: { id: task.id } }); },
  });

  if (q.isPending) return <Loading variant="chat" label="Loading thread" rows={5} />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load the thread" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const { message } = q.data;
  // R35: replies from people you blocked are left out here too (the server does it as well).
  const { messages: replies, hidden } = filterBlocked(q.data.replies, safety.blocked);
  const parentHidden = safety.isBlocked(message.author.id) && message.author.type !== "agent";
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      {toTask.error ? <Banner tone="bad" icon="alert-circle" text={`Couldn't make the task: ${toTask.error.message}`} /> : null}
      <ScrollView contentContainerStyle={{ paddingVertical: space.md }} testID="chat-thread">
        {parentHidden ? <HiddenMessagesRow /> : <ChatMessageRow m={message} meId={meId} sample={mode === "sample"} onLongPress={setMenu} showReplies={false} />}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginVertical: space.sm }}>
          <Text style={font.tiny}>{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
        </View>
        {hidden && !parentHidden ? <HiddenMessagesRow /> : null}
        {replies.map((r, i) => <ChatMessageRow key={r.id} m={r} grouped={i > 0 && replies[i - 1].author.id === r.author.id && !replies[i - 1].deleted
          && new Date(r.createdAt).getTime() - new Date(replies[i - 1].createdAt).getTime() < GROUP_GAP_MS} meId={meId} sample={mode === "sample"} onLongPress={setMenu} showReplies={false} />)}
      </ScrollView>
      <Composer people={people.data ?? []} placeholder="Reply in thread" sending={send.isPending} testID="thread-composer"
        onSend={(body, files, onProgress) => send.mutateAsync({ body, parentId: message.id, attachments: files, onProgress })} />
      <MessageMenu m={menu} onClose={() => setMenu(null)} onMakeTask={makeTask} busy={toTask.isPending}
        onReport={(m) => safety.startReport({ targetType: "message", messageId: m.id, userId: m.author.id, name: m.author.name, context: "chat", canBlock: canBlockAuthor(m, meId) })}
        onBlock={menu && canBlockAuthor(menu, meId) ? (m) => safety.askBlock({ userId: m.author.id, name: m.author.name }) : undefined} />
      {safety.ui}
    </KeyboardAvoidingView>
  );
}
