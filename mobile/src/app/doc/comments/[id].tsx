import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Badge, Button, EmptyState, Loading } from "@/components/ui";
import { useSession } from "@/lib/session";
import { useWebConfig } from "@/lib/web-config";
import { useOffline } from "@/lib/offline";
import { success, warning } from "@/lib/haptics";
import { COMMENT_MAX, commentProblem, moderation, noAccess, type CommentView } from "@/lib/docs";
import { plainProblem, useCommentActions, useDocComments } from "@/lib/docs-queries";
import { colors, radius, space } from "@/theme";

/**
 * M1: a doc's comments (R103 Docs plus): the team thread and approved public comments. Add a team comment, edit or
 * delete your own, and owners, admins and the doc's maker show or hide public ones, exactly as the web allows.
 */
export default function DocComments() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useSession();
  const cfg = useWebConfig();
  const on = !!me?.organization && !!cfg.data?.docsPlus;
  const q = useDocComments(id, on);
  const { add, edit, moderate, remove } = useCommentActions(id ?? "");
  const offline = useOffline();
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);

  if (!me?.organization) return <EmptyState icon="lock" title="No access" body="Comments are for members of a workspace." />;
  if (cfg.data && !cfg.data.docsPlus) return <EmptyState icon="message-square" title="Comments are off" body="Doc comments are not on for this workspace." />;
  if (q.isPending) return <Loading label="Loading comments" rows={4} variant="chat" />;
  if (q.error && !q.data) {
    return noAccess(q.error)
      ? <EmptyState icon="lock" title="Can't see these comments" body="You don't have access to this doc." />
      : <EmptyState icon="alert-circle" title="Couldn't load comments" body={plainProblem(q.error)} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} testID="comments-retry" />} />;
  }
  const data = q.data!;
  const send = () => {
    const p = commentProblem(text);
    if (p) { setProblem(p); warning(); return; }
    setProblem(null);
    add.mutate(text, { onSuccess: () => { setText(""); success(); }, onError: (e) => { setProblem(plainProblem(e)); warning(); } });
  };
  const saveEdit = () => {
    if (!editing) return;
    const p = commentProblem(editing.body);
    if (p) { setProblem(p); warning(); return; }
    edit.mutate(editing, { onSuccess: () => { setEditing(null); setProblem(null); success(); }, onError: (e) => { setProblem(plainProblem(e)); warning(); } });
  };
  const confirmRemove = (c: CommentView) => Alert.alert("Delete this comment?", "It is removed for everyone.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: () => remove.mutate(c.id, { onError: (e) => Alert.alert("Couldn't delete it", plainProblem(e)) }) },
  ]);
  const refresh = async () => { setPulling(true); try { await q.refetch(); } finally { setPulling(false); } };

  const renderComment = (c: CommentView, i: number) => {
    const mod = moderation(c, data.canModerate);
    const isEditing = editing?.id === c.id;
    const when = new Date(c.createdAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    return (
      <View key={c.id} style={[st.comment, i > 0 && st.sepTop]} testID={`comment-${c.id}`}>
        <View style={st.head}>
          <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 15, flexShrink: 1 }} numberOfLines={1}>{c.author.name}{c.mine ? " (you)" : ""}</Text>
          <Text style={{ color: colors.subtle, fontSize: 13 }}>{when}{c.editedAt ? ", edited" : ""}</Text>
          {c.status !== "visible" ? <Badge label={c.status === "hidden" ? "Hidden" : "Waiting"} tone="warn" /> : null}
        </View>
        {isEditing ? (
          <View style={{ gap: space.sm }}>
            <TextInput value={editing.body} onChangeText={(body) => setEditing({ id: c.id, body })} multiline maxLength={COMMENT_MAX} style={[st.input, { minHeight: 80 }]}
              accessibilityLabel="Edit comment" placeholderTextColor={colors.subtle} selectionColor={colors.brand} testID="comment-edit-input" autoFocus />
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button label="Save" onPress={saveEdit} loading={edit.isPending} testID="comment-save" />
              <Button label="Cancel" variant="secondary" onPress={() => { setEditing(null); setProblem(null); }} testID="comment-cancel" />
            </View>
          </View>
        ) : <Text style={{ color: colors.fg, fontSize: 16, lineHeight: 22 }} selectable>{c.body}</Text>}
        {!isEditing && (c.canEdit || c.canRemove || mod) ? (
          <View style={st.tools}>
            {c.canEdit ? <Small label="Edit" onPress={() => { setEditing({ id: c.id, body: c.body }); setProblem(null); }} testID={`comment-edit-${c.id}`} /> : null}
            {mod ? <Small label={mod.label} onPress={() => moderate.mutate({ id: c.id, status: mod.status }, { onError: (e) => Alert.alert("Couldn't change it", plainProblem(e)) })} testID={`comment-mod-${c.id}`} /> : null}
            {c.canRemove ? <Small label="Delete" danger onPress={() => confirmRemove(c)} testID={`comment-delete-${c.id}`} /> : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <ScrollView contentContainerStyle={{ paddingVertical: space.md, paddingBottom: space.xl }} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.subtle} />}>
        <Text style={st.header} accessibilityRole="header">Team, {data.team.length}</Text>
        {data.team.length
          ? <View style={st.group}>{data.team.map(renderComment)}</View>
          : <Text style={st.empty}>No comments yet. Only people in this workspace see them.</Text>}
        {data.publicOn || data.public.length ? (
          <>
            <Text style={[st.header, { marginTop: space.xl }]} accessibilityRole="header">From the share link, {data.public.length}</Text>
            {data.public.length ? <View style={st.group}>{data.public.map(renderComment)}</View> : <Text style={st.empty}>No public comments yet.</Text>}
            {data.canModerate && data.pending ? <Text style={st.note}>{data.pending} waiting for review. Review them on the web.</Text> : null}
          </>
        ) : null}
      </ScrollView>
      <View style={st.composer}>
        {problem ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityLiveRegion="polite" testID="comment-problem">{problem}</Text> : null}
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-end" }}>
          <TextInput value={text} onChangeText={setText} placeholder="Add a comment for the team" placeholderTextColor={colors.subtle} multiline maxLength={COMMENT_MAX}
            selectionColor={colors.brand} accessibilityLabel="Add a comment for the team" style={[st.input, { flex: 1, maxHeight: 120 }]} testID="comment-input" editable={!offline} />
          <Button label="Send" onPress={send} loading={add.isPending} disabled={offline || !text.trim()} testID="comment-send" />
        </View>
        {offline ? <Text style={{ color: colors.subtle, fontSize: 13 }}>{"You're offline. Comments send when you're back."}</Text> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function Small({ label, onPress, danger, testID }: { label: string; onPress: () => void; danger?: boolean; testID: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label} comment`} hitSlop={6} style={st.small} testID={testID}>
      <Text style={{ color: danger ? colors.bad : colors.brand, fontSize: 15, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  header: { color: colors.subtle, fontSize: 13, marginHorizontal: space.xl, marginBottom: 7, textTransform: "uppercase" },
  group: { backgroundColor: colors.surface, marginHorizontal: space.lg, borderRadius: 12, overflow: "hidden" },
  comment: { padding: space.md, gap: space.xs },
  head: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  tools: { flexDirection: "row", gap: space.lg },
  small: { minHeight: 44, justifyContent: "center" },
  sepTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
  empty: { color: colors.subtle, fontSize: 15, marginHorizontal: space.xl },
  note: { color: colors.subtle, fontSize: 13, marginHorizontal: space.xl, marginTop: space.sm },
  composer: { padding: space.md, gap: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong, backgroundColor: colors.surface },
  input: { color: colors.fg, fontSize: 16, backgroundColor: colors.elevated, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10, minHeight: 44 },
});
