import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View, StyleSheet } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Avatar, Badge, Banner, Button, EmptyState, Icon, IconButton, Loading } from "@/components/ui";
import { InsetGroup, GroupRow, SpringIn } from "@/components/grouped";
import { useAgents, useMessageAction, useTaskMutations, useThread } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { displayName, longDate, shortDate } from "@/lib/format";
import { previewLine, splitQuoted } from "@/lib/quote";
import { bodyText } from "@/lib/mail-body";
import { normalizeThreadView } from "@/lib/thread-view";
import { ApiError } from "@/api/errors";
import { LinkedText } from "@/components/linked-text";
import { firstLink, openQuickActions } from "@/lib/quick-actions";
import { animateList } from "@/lib/motion";
import { success, tick, warning } from "@/lib/haptics";
import { FEATURES } from "@/config";
import { StartMeetingButton } from "@/components/meetings";
import { AttachmentRow } from "@/components/attachment-tools";
import type { Message } from "@/api/types";
import { colors, font, radius, shadow, space } from "@/theme";
import { tr } from "@/i18n";
import { ThreadTeam } from "@/components/thread-team";

/**
 * R36: the mail thread, laid out from the measured thread viewers (files/teardowns/rea/spark/mail-thread-r36.md):
 * the subject as a title, earlier messages folded to one 64 pt row each, the newest open with a 68 pt
 * sender header, quoted text folded behind a pill, and a sticky 64 pt reply bar with 44 pt icon buttons.
 */
export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useThread(id);
  const agents = useAgents();
  const action = useMessageAction();
  const tasks = useTaskMutations();
  const offline = useOffline();
  const insets = useSafeAreaInsets();
  // Wave 3: saved copies, prefetches and older servers can hand over partial data; it is fixed up here, and a
  // view with no message id shows the error state instead of throwing.
  const view = q.error ? null : normalizeThreadView(q.data);
  const msg = view?.message;
  const thread = view?.thread ?? [];
  const last = thread[thread.length - 1] ?? msg;
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const act = (a: "archive" | "star" | "unstar" | "unread" | "trash") => {
    if (!msg) return;
    if (a === "trash") warning(); else if (a === "archive") success(); else tick();
    action.mutate({ id: msg.id, action: a }, {
      onSuccess: () => { if (a === "archive" || a === "trash" || a === "unread") router.back(); },
      onError: (e) => { warning(); Alert.alert(tr("m.thread.that_didn_t_work"), e.message); },
    });
  };

  // One call: the server takes the title from the subject, the notes from the newest message and
  // links the task to this thread, so replies show on the task.
  const makeTask = async () => {
    if (!msg) return;
    try {
      const t = await tasks.fromEmail.mutateAsync({ messageId: msg.id });
      success();
      router.push({ pathname: "/task/[id]", params: { id: t.id } });
    } catch (e) {
      warning();
      Alert.alert(tr("m.thread.couldn_t_make_the_task"), (e as Error).message);
    }
  };

  const toggle = (mid: string) => { tick(); animateList(); setOpen((o) => ({ ...o, [mid]: !o[mid] })); };
  const agentName = (m: Message) => m.sentByAgentId ? agents.data?.find((a) => a.id === m.sentByAgentId)?.name ?? tr("m.thread.agent") : undefined;
  const people = new Set(thread.map((m) => m.from.address)).size;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        title: "",
        headerRight: () => msg ? (
          <View style={{ flexDirection: "row" }}>
            <IconButton icon="archive" label={tr("m.thread.archive")} onPress={() => act("archive")} testID="archive" />
            <IconButton icon="star" label={msg.isStarred ? tr("m.thread.remove_star") : tr("m.thread.star")} color={msg.isStarred ? colors.warn : colors.fg} onPress={() => act(msg.isStarred ? "unstar" : "star")} testID="star" />
            <IconButton icon="trash-2" label={tr("m.thread.move_to_trash")} onPress={() => act("trash")} testID="trash" />
            <IconButton icon="more-horizontal" label={tr("m.thread.more_copy_share_translate")} testID="thread-more"
              onPress={() => { const last = thread[thread.length - 1] ?? msg; const body = bodyText(last); openQuickActions({ title: msg.subject || tr("m.thread.no_subject"), subtitle: displayName(last.from), text: [msg.subject, body].filter(Boolean).join("\n\n"), link: firstLink(body) }); }} />
          </View>
        ) : null,
      }} />
      {offline ? <Banner text={tr("m.thread.offline_this_is_the_copy_saved_on_your_phone")} /> : null}
      {q.isPending ? <Loading variant="chat" label={tr("m.thread.loading_conversation")} rows={4} /> : !view ? (
        // The server's own wording (or a TypeError) is not shown; a dropped connection says so in the app's words.
        <EmptyState icon="alert-circle" title={tr("m.thread.couldn_t_open_this_message")}
          body={q.error instanceof ApiError && q.error.isNetwork ? tr("m.common.check_your_connection_and_try_again") : undefined}
          action={(
            <View style={{ gap: space.sm }}>
              <Button label={tr("m.thread.try_again")} variant="secondary" onPress={() => q.refetch()} />
              <Button label={tr(router.canGoBack() ? "m.common.back" : "m.inbox.back_to_inbox")} variant="secondary" onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace("/inbox");
              }} />
            </View>
          )} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingTop: space.md, paddingBottom: 64 + insets.bottom + space.xxl }}>
          <View style={{ paddingHorizontal: space.lg, gap: 6, marginBottom: space.md }}>
            <Text style={[font.title, { fontSize: 24, letterSpacing: 0.2 }]} accessibilityRole="header" selectable>{msg?.subject || tr("m.thread.no_subject")}</Text>
            <Text style={font.small}>{tr("m.thread.n_messages", { count: thread.length })}{people > 1 ? tr("m.thread.from_n_people", { count: people }) : ""}</Text>
          </View>
          <View style={{ gap: space.sm }}>
            {thread.map((m, i) => {
              const newest = i === thread.length - 1;
              // Agent written mail stays open, so a person always sees what an agent sent in their name.
              const expanded = newest || !!m.sentByAgentId || !!open[m.id];
              return expanded
                ? <SpringIn key={m.id}><MessageCard m={m} agentName={agentName(m)} onCollapse={newest || m.sentByAgentId ? undefined : () => toggle(m.id)} /></SpringIn>
                : <CollapsedRow key={m.id} m={m} agentName={agentName(m)} onPress={() => toggle(m.id)} />;
            })}
          </View>
          {msg?.threadId ? <ThreadTeam threadId={msg.threadId} /> : null}
          <InsetGroup header={tr("m.thread.from_this_email")}>
            {FEATURES.tasks ? <GroupRow icon="check-square" tile="blue" label={tr("m.thread.make_a_task_from_this_email")} onPress={makeTask} testID="make-task" value={tasks.fromEmail.isPending ? tr("m.thread.making") : undefined} /> : null}
            {msg?.threadId ? <View style={{ padding: space.md }}><StartMeetingButton source={{ type: "thread", id: msg.threadId }} title={msg.subject || undefined} /></View> : null}
          </InsetGroup>
        </ScrollView>
      )}
      {view && last ? (
        <View style={[t.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          <BarButton icon="corner-up-left" label={tr("m.thread.reply")} testID="reply" primary onPress={() => router.push({ pathname: "/compose", params: { replyTo: last.id } })} />
          {last.to.length + last.cc.length > 1 ? (
            <BarButton icon="users" label={tr("m.thread.reply_all")} testID="reply-all" onPress={() => router.push({ pathname: "/compose", params: { replyTo: last.id, all: "1" } })} />
          ) : null}
          <BarButton icon="corner-up-right" label={tr("m.thread.forward")} testID="forward" onPress={() => router.push({ pathname: "/compose", params: { forward: last.id } })} />
          <BarButton icon="mail" label={tr("m.thread.mark_unread")} testID="mark-unread" onPress={() => act("unread")} />
        </View>
      ) : null}
    </View>
  );
}

/** A message with no readable date (a partial saved copy) shows none rather than throwing in the date formatter. */
const when = (iso: string) => (iso ? shortDate(iso) : "");

/** A 44 pt target with a 36 pt round fill and a 20 pt icon, label under it (measured composer toolbar). */
function BarButton({ icon, label, onPress, testID, primary }: { icon: "corner-up-left" | "corner-up-right" | "users" | "mail"; label: string; onPress: () => void; testID?: string; primary?: boolean }) {
  return (
    <Pressable onPress={() => { tick(); onPress(); }} testID={testID} accessibilityRole="button" accessibilityLabel={label} hitSlop={4}
      style={({ pressed }) => [t.barBtn, pressed && { opacity: 0.6, transform: [{ scale: 0.96 }] }]}>
      <View style={[t.barFill, primary && { backgroundColor: colors.brandFill }]}><Icon name={icon} size={20} color={primary ? colors.brandFg : colors.fg} /></View>
      <Text style={[t.barLabel, primary && { color: colors.brand, fontWeight: "600" }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function CollapsedRow({ m, agentName, onPress }: { m: Message; agentName?: string; onPress: () => void }) {
  const name = agentName ?? displayName(m.from);
  return (
    <Pressable onPress={onPress} testID={`collapsed-${m.id}`} accessibilityRole="button" accessibilityLabel={`${name}, ${when(m.date)}. ${previewLine(bodyText(m))}`} accessibilityHint={tr("m.thread.opens_this_message")}
      style={({ pressed }) => [t.card, t.collapsed, pressed && { backgroundColor: colors.hover }]}>
      <Avatar name={name} agent={!!agentName} size={32} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 15, flex: 1 }} numberOfLines={1}>{name}</Text>
          {m.attachments.length ? <Icon name="paperclip" size={13} color={colors.subtle} /> : null}
          <Text style={t.time}>{when(m.date)}</Text>
        </View>
        <Text style={{ color: colors.muted, fontSize: 14 }} numberOfLines={1}>{previewLine(bodyText(m)) || tr("m.thread.no_text")}</Text>
      </View>
    </Pressable>
  );
}

function MessageCard({ m, agentName, onCollapse }: { m: Message; agentName?: string; onCollapse?: () => void }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const { body, quoted } = splitQuoted(bodyText(m));
  const name = agentName ?? displayName(m.from);
  return (
    <View style={[t.card, agentName ? { borderColor: colors.brandLine } : null]} testID={`message-${m.id}`}>
      <Pressable onPress={onCollapse} disabled={!onCollapse} accessibilityRole={onCollapse ? "button" : undefined} accessibilityHint={onCollapse ? tr("m.thread.folds_this_message") : undefined}
        style={t.header}>
        <Avatar name={name} agent={!!agentName} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
            <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 17, flex: 1, letterSpacing: -0.41 }} numberOfLines={1}>{name}</Text>
            <Text style={t.time}>{when(m.date)}</Text>
          </View>
          <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={1}>
            {tr("m.thread.to_names", { names: m.to.map(displayName).join(", ") || tr("m.thread.me") })}{m.cc.length ? tr("m.thread.cc_names", { names: m.cc.map(displayName).join(", ") }) : ""}
          </Text>
        </View>
      </Pressable>
      {agentName ? <View style={{ paddingHorizontal: space.lg }}><Badge label={tr("m.thread.written_by_agent_agentname", { agentName: agentName })} tone="brand" icon="cpu" /></View> : null}
      <Text style={[font.body, { paddingHorizontal: space.lg, paddingTop: space.sm }]} selectable accessibilityHint={m.date ? longDate(m.date) : undefined}>
        {body ? <LinkedText text={body} testID={`body-${m.id}`} /> : tr("m.thread.this_message_is_empty")}
      </Text>
      {quoted ? (
        <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
          <Pressable onPress={() => { tick(); animateList(); setShowQuoted((v) => !v); }} accessibilityRole="button" testID={`quoted-${m.id}`}
            accessibilityLabel={showQuoted ? tr("m.thread.hide_quoted_text") : tr("m.thread.show_quoted_text")} hitSlop={8} style={({ pressed }) => [t.pill, pressed && { opacity: 0.6 }]}>
            <Icon name="more-horizontal" size={16} color={colors.muted} />
            <Text style={{ color: colors.muted, fontSize: 13, fontWeight: "500" }}>{showQuoted ? tr("m.thread.hide_quoted_text") : tr("m.thread.show_quoted_text")}</Text>
          </Pressable>
          {showQuoted ? <Text style={t.quoted} selectable><LinkedText text={quoted} testID={`quotedtext-${m.id}`} /></Text> : null}
        </View>
      ) : null}
      {m.attachments.length ? (
        <View style={{ gap: space.sm, paddingHorizontal: space.lg }}>
          {m.attachments.map((a) => <AttachmentRow key={a.id} a={a} />)}
        </View>
      ) : null}
      <View style={{ height: space.lg }} />
    </View>
  );
}

const t = StyleSheet.create({
  card: { marginHorizontal: space.md, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, gap: space.sm, ...shadow },
  collapsed: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  header: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingTop: 12 },
  time: { color: colors.subtle, fontSize: 13, fontVariant: ["tabular-nums"] },
  pill: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 14, backgroundColor: colors.neutralSoft },
  quoted: { color: colors.muted, fontSize: 15, lineHeight: 20, borderLeftWidth: 3, borderLeftColor: colors.lineStrong, paddingLeft: 19 },
  attachment: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: colors.neutralSoft },
  fileTile: { width: 36, height: 36, borderRadius: 8, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, minHeight: 64, paddingTop: space.sm, paddingHorizontal: space.md, flexDirection: "row", justifyContent: "space-around",
    backgroundColor: Platform.OS === "ios" ? colors.surface : colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  barBtn: { minWidth: 64, minHeight: 44, alignItems: "center", gap: 3 },
  barFill: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.neutralSoft },
  barLabel: { color: colors.muted, fontSize: 11, fontWeight: "500" },
});
