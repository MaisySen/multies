import { Alert, ScrollView, Text, View, Platform } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { Avatar, Badge, Banner, Button, EmptyState, Icon, IconButton, Loading } from "@/components/ui";
import { useAgents, useMessageAction, useTaskMutations, useThread } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { bytes, displayName, longDate } from "@/lib/format";
import { FEATURES } from "@/config";
import type { Message } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useThread(id);
  const agents = useAgents();
  const action = useMessageAction();
  const tasks = useTaskMutations();
  const offline = useOffline();
  const msg = q.data?.message;
  const thread = q.data?.thread ?? [];
  const last = thread[thread.length - 1] ?? msg;

  const act = (a: "archive" | "star" | "unstar" | "unread" | "trash") => {
    if (!msg) return;
    action.mutate({ id: msg.id, action: a }, {
      onSuccess: () => { if (a === "archive" || a === "trash" || a === "unread") router.back(); },
      onError: (e) => Alert.alert("That didn't work", e.message),
    });
  };

  const makeTask = async () => {
    if (!msg) return;
    const t = await tasks.create.mutateAsync({
      title: msg.subject || "Follow up",
      notes: `From ${displayName(msg.from)}: ${msg.snippet}`,
      source: { messageId: msg.id, threadId: msg.threadId, from: displayName(msg.from), subject: msg.subject },
    });
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    router.push({ pathname: "/task/[id]", params: { id: t.id } });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        title: "",
        headerRight: () => msg ? (
          <View style={{ flexDirection: "row" }}>
            <IconButton icon="archive" label="Archive" onPress={() => act("archive")} testID="archive" />
            <IconButton icon="star" label={msg.isStarred ? "Remove star" : "Star"} color={msg.isStarred ? colors.warn : colors.fg} onPress={() => act(msg.isStarred ? "unstar" : "star")} />
            <IconButton icon="trash-2" label="Move to trash" onPress={() => act("trash")} />
          </View>
        ) : null,
      }} />
      {offline ? <Banner text="Offline. This is the copy saved on your phone." /> : null}
      {q.isPending ? <Loading /> : q.error ? (
        <EmptyState icon="alert-circle" title="Couldn't open this message" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 120 }}>
          <Text style={[font.title, { fontSize: 23 }]} accessibilityRole="header">{msg?.subject || "(no subject)"}</Text>
          {thread.map((m) => <MessageCard key={m.id} m={m} agentName={m.sentByAgentId ? agents.data?.find((a) => a.id === m.sentByAgentId)?.name ?? "Agent" : undefined} />)}
          {FEATURES.tasks ? (
            <Button variant="secondary" icon="check-square" label="Make a task from this email" onPress={makeTask} testID="make-task" />
          ) : null}
        </ScrollView>
      )}
      {last ? (
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: space.lg, paddingBottom: space.xl, backgroundColor: colors.bg, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: "row", gap: space.sm }}>
          <Button label="Reply" icon="corner-up-left" style={{ flex: 1 }} testID="reply"
            onPress={() => router.push({ pathname: "/compose", params: { replyTo: last.id } })} />
          <Button label="Forward" icon="corner-up-right" variant="secondary" style={{ flex: 1 }}
            onPress={() => router.push({ pathname: "/compose", params: { forward: last.id } })} />
        </View>
      ) : null}
    </View>
  );
}

function MessageCard({ m, agentName }: { m: Message; agentName?: string }) {
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: agentName ? "rgba(255,106,61,0.35)" : colors.line, padding: space.lg, gap: space.md }}>
      <View style={{ flexDirection: "row", gap: space.md, alignItems: "center" }}>
        <Avatar name={displayName(m.from)} agent={!!agentName} size={36} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 15 }} numberOfLines={1}>{agentName ?? displayName(m.from)}</Text>
          <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={1}>{m.from.address}</Text>
        </View>
        <Text style={{ color: colors.subtle, fontSize: 12 }}>{longDate(m.date)}</Text>
      </View>
      {agentName ? <Badge label={`Written by agent ${agentName}`} tone="brand" icon="cpu" /> : null}
      <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={2}>To: {m.to.map(displayName).join(", ")}{m.cc.length ? `  Cc: ${m.cc.map(displayName).join(", ")}` : ""}</Text>
      <Text style={font.body} selectable>{m.text?.trim() || "This message has no plain text version. Open it on the web to see it in full."}</Text>
      {m.attachments.length ? (
        <View style={{ gap: space.sm }}>
          {m.attachments.map((a) => (
            <View key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.elevated }}
              accessible accessibilityLabel={`Attachment ${a.filename}, ${bytes(a.sizeBytes)}`}>
              <Icon name="paperclip" size={16} />
              <Text style={{ color: colors.fg, flex: 1 }} numberOfLines={1}>{a.filename}</Text>
              <Text style={{ color: colors.subtle, fontSize: 13 }}>{bytes(a.sizeBytes)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
