/**
 * MPAR3: the shared inbox on a thread, as on the web (Round 22): who it is assigned to, its status (open, waiting,
 * done) and internal notes only teammates see (GET/POST /api/threads/:id/state, assign, status, comments).
 * Hidden where the web hides it: a mailbox nobody shares answers 404 and the section stays out of the way.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Avatar, Button, Icon, Segmented } from "@/components/ui";
import { Note, Sheet, SheetAction } from "@/components/mpar3-ui";
import { colors, font, lh, radius, space, TOUCH } from "@/theme";
import { currentLocale, tr } from "@/i18n";
import { success, tick, warning } from "@/lib/haptics";
import { calFmt, COMMENT_MAX, THREAD_STATUSES, type ThreadStatus } from "@/lib/mpar3";
import { isOff, useCommentActions, useThreadActions, useThreadComments, useThreadState } from "@/lib/mpar3-queries";

export function ThreadTeam({ threadId }: { threadId: string }) {
  const q = useThreadState(threadId);
  const act = useThreadActions(threadId);
  const comments = useThreadComments(threadId, !!q.data);
  const cact = useCommentActions(threadId);
  const [assigning, setAssigning] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (q.error && isOff(q.error)) return null;
  if (!q.data) return null;
  const { state, members } = q.data;
  const people = members.filter((m) => !m.agent);
  const assign = async (userId: string | null) => {
    setErr(null);
    try { await act.assign.mutateAsync(userId); success(); setAssigning(false); } catch (x) { warning(); setErr((x as Error).message); }
  };
  const setStatus = async (s: ThreadStatus) => {
    setErr(null); tick();
    try { await act.status.mutateAsync(s); } catch (x) { warning(); setErr((x as Error).message); }
  };
  const post = async () => {
    const body = note.trim();
    if (!body) return;
    setErr(null);
    try { await cact.add.mutateAsync(body); setNote(""); success(); } catch (x) { warning(); setErr((x as Error).message); }
  };
  const list = comments.data?.comments ?? [];
  return (
    <View style={st.card} testID="thread-team">
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name="users" size={18} color={colors.brand} />
        <Text style={font.headline} accessibilityRole="header">{tr("m.team.title")}</Text>
      </View>
      <Pressable onPress={() => { tick(); setAssigning(true); }} accessibilityRole="button" testID="thread-assign"
        accessibilityLabel={`${tr("m.team.assigned")}, ${state.assignee ? state.assignee.name : tr("m.team.nobody")}`}
        style={({ pressed }) => [st.assign, pressed && { backgroundColor: colors.hover }]}>
        <Text style={{ color: colors.muted, fontSize: 15, lineHeight: lh(20) }}>{tr("m.team.assigned")}</Text>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.sm }}>
          {state.assignee ? <Avatar name={state.assignee.name} size={24} /> : null}
          <Text style={{ color: state.assignee ? colors.fg : colors.subtle, fontSize: 15, fontWeight: "600", lineHeight: lh(20), flexShrink: 1 }} numberOfLines={1}>{state.assignee ? state.assignee.name : tr("m.team.nobody")}</Text>
          <Icon name="chevron-right" size={16} color={colors.subtle} />
        </View>
      </Pressable>
      <Segmented value={state.status} label={tr("m.team.status")} onChange={setStatus} options={THREAD_STATUSES.map((s) => ({ id: s, label: tr(`m.team.status_${s}`) }))} />
      <View style={{ gap: space.sm }} testID="thread-comments">
        <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500", lineHeight: lh(19) }}>{tr("m.team.notes", { count: list.length })}</Text>
        {list.map((c) => (
          <View key={c.id} style={st.comment} testID={`comment-${c.id}`}>
            <Avatar name={c.author.name} size={28} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600", lineHeight: lh(19) }}>{c.author.name}
                <Text style={{ color: colors.subtle, fontWeight: "400" }}>{`  ${calFmt(new Date(c.createdAt), { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`}</Text>
              </Text>
              <Text style={{ color: colors.fg, fontSize: 15, lineHeight: lh(21) }} selectable>{c.body}</Text>
            </View>
            {/* PRIV1b (P67): a delete that fails shows the error instead of leaving the note without a word. */}
            {c.canDelete ? (
              <Pressable onPress={() => { tick(); setErr(null); cact.remove.mutate(c.id, { onError: (x) => { warning(); setErr((x as Error).message || tr("m.bulk.failed")); } }); }} accessibilityRole="button" accessibilityLabel={tr("m.team.delete_note")} hitSlop={4}
                style={({ pressed }) => [st.del, pressed && { opacity: 0.6 }]} testID={`comment-delete-${c.id}`}>
                <Icon name="trash-2" size={16} color={colors.subtle} />
              </Pressable>
            ) : null}
          </View>
        ))}
        <TextInput value={note} onChangeText={setNote} placeholder={tr("m.team.note_placeholder")} placeholderTextColor={colors.subtle} multiline maxLength={COMMENT_MAX}
          accessibilityLabel={tr("m.team.add_note")} selectionColor={colors.brand} testID="team-note"
          style={{ minHeight: 64, color: colors.fg, fontSize: 15, lineHeight: lh(21), padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.bg, textAlignVertical: "top" }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ flex: 1 }}><Note>{tr("m.team.only_team")}</Note></View>
          <Button label={tr("m.team.add_note")} variant="secondary" onPress={post} disabled={!note.trim()} loading={cact.add.isPending} testID="team-note-add" style={{ minHeight: TOUCH }} />
        </View>
      </View>
      {err ? <Note tone="bad">{err}</Note> : null}
      <Sheet visible={assigning} onClose={() => setAssigning(false)} title={tr("m.team.assign_to")} testID="assign-sheet">
        {people.map((m) => <SheetAction key={m.id} icon={state.assignee?.id === m.id ? "check" : "user"} label={m.name || m.email} onPress={() => assign(m.id)} testID={`assign-${m.id}`} />)}
        {state.assignee ? <SheetAction icon="user-x" label={tr("m.team.unassign")} onPress={() => assign(null)} destructive testID="assign-none" /> : null}
      </Sheet>
    </View>
  );
}

const st = StyleSheet.create({
  card: { marginHorizontal: space.lg, marginTop: space.lg, padding: space.lg, gap: space.md, backgroundColor: colors.surface, borderRadius: 14 },
  assign: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.sm, marginHorizontal: -space.sm, borderRadius: radius.md },
  comment: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  del: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", marginTop: -10, marginRight: -10 },
});
