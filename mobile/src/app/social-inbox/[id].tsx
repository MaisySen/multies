import { useEffect, useRef, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Banner, Button, EmptyState, Segmented, Skeleton } from "@/components/ui";
import { LinkText, NetworkMark, openPost, plainError, Section, useKeyboardLift } from "@/components/social";
import { ago } from "@/lib/social";
import {
  INBOX_KIND_LABEL, NOTE_MAX, REPLY_MAX, assignChoices, assigneeLine, fillSavedReply, networkLabel, replyWindow, whoWrote,
  type InboxListResponse, type InboxNoteView,
} from "@/lib/social-inbox";
import { useInboxActions, useInboxThread, useSavedReplies } from "@/lib/social-queries";
import { useQueryClient } from "@tanstack/react-query";
import { useOffline } from "@/lib/offline";
import { useNow } from "@/lib/use-now";
import { success, tick, warning } from "@/lib/haptics";
import { colors, font, radius, space } from "@/theme";

type Mode = "reply" | "note";

/**
 * 1.10.8: one conversation from the Social inbox: the message and its thread, who has it, the reply window for Facebook
 * and Instagram messages, Reply or Note, saved replies, Make task and Mark done with Undo. The server checks every rule.
 */
export default function InboxItem() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useInboxThread(id);
  const qc = useQueryClient();
  const { patch, note, reply, task } = useInboxActions(id ?? "");
  const saved = useSavedReplies(!!id);
  const offline = useOffline();
  const insets = useSafeAreaInsets();
  const { ref: liftRef, lift, keyboardUp } = useKeyboardLift();
  const [mode, setMode] = useState<Mode>("reply");
  const [text, setText] = useState("");
  const [undo, setUndo] = useState(false);
  const [pulling, setPulling] = useState(false);
  const now = useNow();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Who I am, the people and whether I manage come with the list; the thread read does not repeat them.
  const list = qc.getQueriesData<InboxListResponse>({ queryKey: ["social", "inbox", "list"] }).map(([, d]) => d).find(Boolean);
  const me = list?.me ?? "";
  const canManage = !!list?.canManage;
  const people = list?.people ?? [];

  if (q.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.lg, gap: space.md }} testID="inbox-item-loading" accessibilityLabel="Loading conversation" accessible>
        <Skeleton width="60%" height={20} /><Skeleton width="100%" height={60} /><Skeleton width="80%" />
      </View>
    );
  }
  if (q.error && !q.data) {
    return <EmptyState icon="alert-circle" title="Couldn't open this conversation" body={plainError(q.error)} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} testID="inbox-item-retry" />} />;
  }
  const { item, notes } = q.data!;
  const w = replyWindow(item.app, item.kind, item.lastInboundAt, now);
  const replyClosed = w.state === "closed";
  const sendMode: Mode = replyClosed ? "note" : mode;
  const max = sendMode === "reply" ? REPLY_MAX : NOTE_MAX;
  const busy = reply.isPending || note.isPending;
  const choices = assignChoices(item, me, canManage, people);
  const who = whoWrote(item);
  const done = item.status === "done";

  const send = () => {
    const body = text.trim();
    if (!body || busy) return;
    const m = sendMode === "reply" ? reply : note;
    m.mutate(body, {
      onSuccess: (r) => {
        const failed = "note" in r && r.note.status === "failed";
        if (failed) warning(); else success();
        if (!failed) setText("");
      },
      onError: (e) => { warning(); Alert.alert(sendMode === "reply" ? "Reply not sent" : "Note not saved", plainError(e)); },
    });
  };
  const assign = (to: string | null) => {
    tick();
    patch.mutate({ assigneeId: to }, { onError: (e) => { warning(); Alert.alert("Couldn't change who has it", plainError(e)); } });
  };
  const setDone = (status: "open" | "done") => {
    patch.mutate({ status }, {
      onSuccess: () => {
        if (status === "done") {
          success(); setUndo(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setUndo(false), 8000);
        } else setUndo(false);
      },
      onError: (e) => { warning(); Alert.alert("Couldn't save", plainError(e)); },
    });
  };
  const makeTask = () => task.mutate(undefined, { onSuccess: () => success(), onError: (e) => { warning(); Alert.alert("Couldn't make a task", plainError(e)); } });
  const refresh = async () => { setPulling(true); try { await q.refetch(); } finally { setPulling(false); } };

  return (
    <View ref={liftRef} style={{ flex: 1, backgroundColor: colors.bg, paddingBottom: lift }} testID="inbox-item">
      <Stack.Screen options={{ title: INBOX_KIND_LABEL[item.kind] }} />
      <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.brand} />}>
        {offline ? <Banner text="You're offline. Replies and notes send when you're back." /> : null}
        <View style={styles.card} testID="inbox-item-message">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <NetworkMark app={item.app} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={font.headline} numberOfLines={2}>{who}</Text>
              <Text style={[font.small, { color: colors.muted }]}>{INBOX_KIND_LABEL[item.kind]} on {item.accountLabel}, {ago(item.receivedAt)}</Text>
            </View>
            {done ? <Badge label="Done" tone="ok" icon="check" /> : null}
          </View>
          <Text style={[font.body, { color: colors.fg }]} selectable>{item.text}</Text>
          {item.postText ? <Text style={[font.small, { color: colors.muted }]} numberOfLines={3}>On your post: {item.postText}</Text> : null}
          {item.postUrl ? <LinkText label={`Open on ${networkLabel(item.app)}`} onPress={() => openPost(item.postUrl!)} testID="inbox-open-post" /> : null}
        </View>

        {w.state === "open" ? <Banner tone={w.soon ? "warn" : "neutral"} icon="clock" text={`${w.text}. ${networkLabel(item.app)} only takes replies within 24 hours of their last message.`} /> : null}
        {w.state === "closed" ? <View testID="inbox-window-closed"><Banner tone="bad" icon="clock" text={w.text} /></View> : null}

        <Section title="Who has it">
          <View style={{ gap: space.sm }} testID="inbox-assign">
            <Text style={[font.body, { color: colors.fg }]} testID="inbox-assignee">{assigneeLine(item, me)}</Text>
            {choices.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                {choices.map((c) => (
                  <Pressable key={c.id ?? "none"} onPress={() => assign(c.id)} disabled={patch.isPending || offline} accessibilityRole="button"
                    accessibilityLabel={c.id === null && !canManage ? "Let go of this conversation" : c.id === me && !canManage ? "Take this conversation" : `Give to ${c.label}`}
                    style={[styles.pill, (patch.isPending || offline) && { opacity: 0.5 }]} testID={`inbox-assign-${c.id ?? "none"}`}>
                    <Text style={{ color: colors.brandHover, fontWeight: "600" }}>{c.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : <Text style={[font.small, { color: colors.muted }]}>Only owners and admins can hand a conversation to someone else.</Text>}
          </View>
        </Section>

        <Section title="Replies and notes">
          {notes.length ? notes.map((n) => <NoteRow key={n.id} n={n} />) : <Text style={[font.small, { color: colors.muted }]} testID="inbox-no-notes">No replies or notes yet. Notes stay inside your team.</Text>}
        </Section>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {done
            ? <Button label="Reopen" variant="secondary" icon="undo" onPress={() => setDone("open")} loading={patch.isPending && patch.variables?.status === "open"} disabled={offline} testID="inbox-reopen" />
            : <Button label="Mark done" icon="check" onPress={() => setDone("done")} loading={patch.isPending && patch.variables?.status === "done"} disabled={offline} testID="inbox-done" />}
          {item.taskId
            ? <Button label="Open task" variant="secondary" icon="check-square" onPress={() => router.push({ pathname: "/task/[id]", params: { id: item.taskId! } })} testID="inbox-open-task" />
            : <Button label="Make task" variant="secondary" icon="check-square" onPress={makeTask} loading={task.isPending} disabled={offline} testID="inbox-make-task" />}
        </View>
        {undo && done ? (
          <View style={styles.undo} accessibilityLiveRegion="polite" testID="inbox-undo-bar">
            <Text style={[font.body, { color: colors.fg, flex: 1 }]}>Marked done.</Text>
            <Button label="Undo" variant="ghost" onPress={() => setDone("open")} testID="inbox-undo" style={{ minHeight: 44 }} />
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: keyboardUp ? space.sm : insets.bottom + space.sm }]} testID="inbox-composer">
        {replyClosed ? null : <Segmented label="Write a" value={mode} options={[{ id: "reply", label: "Reply" }, { id: "note", label: "Note" }]} onChange={(v) => { tick(); setMode(v); }} />}
        {sendMode === "reply" && saved.data?.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} accessibilityLabel="Saved replies" keyboardShouldPersistTaps="handled" testID="inbox-saved">
            {saved.data.map((r) => (
              <Pressable key={r.id} onPress={() => { tick(); setText(fillSavedReply(r.body, item.authorName)); }} accessibilityRole="button" accessibilityLabel={`Use saved reply ${r.title}`}
                style={styles.pill} testID={`inbox-saved-${r.id}`}>
                <Text style={{ color: colors.brandHover, fontWeight: "600" }} numberOfLines={1}>{r.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
          <TextInput value={text} onChangeText={setText} maxLength={max} multiline placeholder={sendMode === "reply" ? `Reply to ${who} on ${networkLabel(item.app)}` : "Note for your team"}
            placeholderTextColor={colors.subtle} style={styles.input} accessibilityLabel={sendMode === "reply" ? "Reply" : "Note"} testID="inbox-input" />
          <Button label={sendMode === "reply" ? "Send" : "Save"} onPress={send} loading={busy} disabled={!text.trim() || offline} testID="inbox-send" style={{ minHeight: 44 }} />
        </View>
        {sendMode === "reply" ? <Text style={[font.tiny, { color: colors.subtle }]}>Your reply goes out on {networkLabel(item.app)} as {item.accountLabel}.</Text> : null}
      </View>
    </View>
  );
}

function NoteRow({ n }: { n: InboxNoteView }) {
  const failed = n.status === "failed";
  const title = n.kind === "reply" ? `${n.authorName ?? "Someone"} replied` : `Note from ${n.authorName ?? "someone"}`;
  return (
    <View style={[styles.note, n.kind === "note" && { backgroundColor: colors.warnSoft }]} testID={`inbox-note-${n.id}`}
      accessible accessibilityLabel={`${title}, ${ago(n.createdAt)}, ${n.text}${failed ? `, not sent: ${n.error ?? ""}` : ""}`}>
      <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}>
        <Text style={[font.small, { color: colors.muted, flex: 1, fontWeight: "600" }]}>{title}</Text>
        <Text style={[font.tiny, { color: colors.muted }]}>{ago(n.createdAt)}</Text>
      </View>
      <Text style={[font.body, { color: colors.fg }]} selectable>{n.text}</Text>
      {failed ? <Text style={[font.small, { color: colors.bad }]}>Not sent. {n.error ?? "Try again in a minute."}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  note: { backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, gap: 4, marginBottom: space.sm },
  pill: { minHeight: 44, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.brandLine, backgroundColor: colors.brandSoft, justifyContent: "center" },
  undo: { flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.md, borderRadius: radius.lg, backgroundColor: colors.surface },
  composer: { gap: space.sm, paddingHorizontal: space.lg, paddingTop: space.sm, backgroundColor: colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  input: { flex: 1, minHeight: 44, maxHeight: 140, paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11, borderRadius: radius.md, backgroundColor: colors.surface, color: colors.fg, fontSize: 16 },
});
