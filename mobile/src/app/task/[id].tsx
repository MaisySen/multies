import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Avatar, Badge, Banner, Button, Chip, EmptyState, Field, Icon, Loading } from "@/components/ui";
import { useAssignees, useTask, useTaskMutations } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { PRIORITIES, STATUSES, dayFrom, dayLabel, dueLabel, nextMonday } from "@/lib/tasks";
import { displayName, longDate, shortDate } from "@/lib/format";
import { ApiError } from "@/api/errors";
import type { AssigneeId, Task, TaskPatch } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useTask(id);
  const people = useAssignees();
  const m = useTaskMutations();
  const offline = useOffline();
  const t = q.data?.task;
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [comment, setComment] = useState("");
  const [subtask, setSubtask] = useState("");
  // Refill the editable fields whenever a newer copy of the task arrives (React's "adjust state
  // when a prop changes" pattern, without an effect).
  const [seen, setSeen] = useState<string | null>(null);
  const stamp = t ? `${t.id}:${t.version}` : null;
  if (t && stamp !== seen) { setSeen(stamp); setTitle(t.title); setNotes(t.notes); }

  if (q.isPending) return <Loading />;
  if (!t || !q.data) return <EmptyState icon="check-square" title="Task not found" body="It may have been deleted, or it isn't shared with you." />;
  const d = q.data;

  const save = (patch: TaskPatch, withVersion = false) => m.update.mutate({ id: t.id, patch: withVersion ? { ...patch, version: t.version } : patch }, {
    onError: (e) => Alert.alert(e instanceof ApiError && e.status === 409 ? "Changed somewhere else" : "That didn't save",
      e instanceof ApiError && e.status === 409 ? "Someone changed this task while you were editing. Showing the latest now." : e.message),
  });
  const del = () => {
    const go = () => m.remove.mutate(t.id, { onSuccess: () => router.back() });
    if (Platform.OS === "web") return go();
    Alert.alert("Delete this task?", undefined, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: go }]);
  };
  const addComment = () => {
    const body = comment.trim();
    if (!body) return;
    m.comment.mutate({ id: t.id, body }, { onSuccess: () => setComment(""), onError: (e) => Alert.alert("Comment not added", e.message) });
  };
  const addSubtask = () => {
    const title = subtask.trim();
    if (!title) return;
    m.create.mutate({ title, parentId: t.id, projectId: t.projectId ?? undefined }, { onSuccess: () => setSubtask(""), onError: (e) => Alert.alert("Subtask not added", e.message) });
  };
  const due = dueLabel(t.due);
  const dueChoices: { label: string; value: string | null }[] = [
    { label: "Today", value: dayFrom(0) }, { label: "Tomorrow", value: dayFrom(1) }, { label: "Next week", value: nextMonday() }, { label: "No date", value: null },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: t.ref }} />
      {offline ? <Banner text="You're offline. This is the copy saved on this phone." /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Badge label={t.statusName} tone={t.status === "done" ? "ok" : t.status === "doing" ? "warn" : "neutral"} />
        {due && t.status !== "done" ? <Badge label={due.text} tone={due.tone === "plain" ? "neutral" : due.tone} icon="calendar" /> : null}
        {t.labels.map((l) => <Badge key={l} label={l} icon="tag" />)}
      </View>

      <Field label="Title" value={title} onChangeText={setTitle} testID="task-title"
        onEndEditing={() => title.trim() && title !== t.title && save({ title: title.trim() }, true)} />

      <Group label="Status">
        {STATUSES.map((s) => <Chip key={s.id} label={s.label} selected={t.status === s.id} onPress={() => t.status !== s.id && save({ status: s.id })} />)}
      </Group>
      <Group label="Priority">
        {PRIORITIES.map((p) => <Chip key={p.id} label={p.label} selected={t.priority === p.id} onPress={() => t.priority !== p.id && save({ priority: p.id })} />)}
      </Group>
      <Group label={t.due ? `Due ${dayLabel(t.due)}` : "Due date"}>
        {dueChoices.map((c) => <Chip key={c.label} label={c.label} selected={(t.due?.slice(0, 10) ?? null) === c.value} onPress={() => save({ due: c.value })} />)}
      </Group>
      <Group label="Assigned to">
        <Chip label="Nobody" selected={!t.assigneeId} onPress={() => t.assigneeId && save({ assigneeId: null })} />
        {(people.data ?? []).map((p) => (
          <Chip key={p.id} label={p.type === "agent" ? `${p.name} (agent)` : p.name} selected={t.assigneeId === p.id} onPress={() => t.assigneeId !== p.id && save({ assigneeId: p.id as AssigneeId })} />
        ))}
      </Group>

      <Field label="Notes" value={notes} onChangeText={setNotes} multiline style={{ minHeight: 110, textAlignVertical: "top", paddingTop: 12 }}
        onEndEditing={() => notes !== t.notes && save({ notes }, true)} />

      <Section title={`Subtasks${d.subtasks.length ? ` (${d.subtasks.filter((s) => s.status === "done").length}/${d.subtasks.length})` : ""}`}>
        {d.subtasks.map((s) => <Subtask key={s.id} s={s} onToggle={() => m.update.mutate({ id: s.id, patch: { status: s.status === "done" ? "todo" : "done" } })} />)}
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-end" }}>
          <View style={{ flex: 1 }}><Field label="Add a subtask" value={subtask} onChangeText={setSubtask} onSubmitEditing={addSubtask} returnKeyType="done" testID="subtask-input" /></View>
          <Button label="Add" variant="secondary" onPress={addSubtask} loading={m.create.isPending} style={{ minHeight: 48 }} testID="add-subtask" />
        </View>
      </Section>

      {t.source ? (
        <Section title={`Email thread${d.thread.length ? ` (${d.thread.length})` : ""}`}>
          {d.thread.length ? d.thread.map((r) => (
            <Pressable key={r.id} onPress={() => router.push({ pathname: "/thread/[id]", params: { id: r.id } })} accessibilityRole="button"
              accessibilityLabel={`Email from ${displayName(r.from)}, ${shortDate(r.date)}`}
              style={{ backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Avatar name={displayName(r.from)} agent={r.byAgent} size={28} />
                <Text style={{ color: colors.fg, fontWeight: "600", flex: 1 }} numberOfLines={1}>{displayName(r.from)}</Text>
                {r.byAgent ? <Badge label="Agent" tone="brand" /> : r.direction === "outbound" ? <Badge label="Sent" /> : null}
                <Text style={font.tiny}>{shortDate(r.date)}</Text>
              </View>
              <Text style={[font.small, { color: colors.fg }]} numberOfLines={6}>{r.latestText || r.subject}</Text>
            </Pressable>
          )) : <Text style={font.small}>From {t.source.from ?? "an email"}: {t.source.subject ?? ""}</Text>}
          {t.source.messageId ? (
            <Button variant="secondary" icon="mail" label="Open the email" testID="open-email"
              onPress={() => router.push({ pathname: "/thread/[id]", params: { id: t.source!.messageId! } })} />
          ) : null}
        </Section>
      ) : null}

      <Section title={`Comments${d.comments.length ? ` (${d.comments.length})` : ""}`}>
        {d.comments.map((c) => (
          <View key={c.id} style={{ flexDirection: "row", gap: space.sm }}>
            <Avatar name={c.author.name ?? "?"} agent={c.author.type === "agent"} size={28} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 14 }}>{c.author.name ?? "Someone"} <Text style={font.tiny}>{shortDate(c.createdAt)}</Text></Text>
              <Text style={font.body}>{c.body}</Text>
            </View>
          </View>
        ))}
        <Field label="Add a comment" value={comment} onChangeText={setComment} multiline style={{ minHeight: 64, textAlignVertical: "top", paddingTop: 12 }} testID="comment-input" />
        <Button label="Post comment" icon="send" variant="secondary" onPress={addComment} loading={m.comment.isPending} disabled={!comment.trim()} testID="post-comment" />
      </Section>

      <Text style={font.tiny}>Created {longDate(t.createdAt)}{t.completedAt ? `. Done ${longDate(t.completedAt)}` : ""}</Text>
      <Button variant="danger" icon="trash-2" label="Delete task" onPress={del} />
    </ScrollView>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }} accessibilityRole="radiogroup" accessibilityLabel={label}>{children}</View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }} accessibilityRole="header">{title}</Text>
      {children}
    </View>
  );
}

function Subtask({ s, onToggle }: { s: Task; onToggle: () => void }) {
  const done = s.status === "done";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line }}>
      <Pressable onPress={onToggle} role="checkbox" aria-checked={done} accessibilityState={{ checked: done }} accessibilityLabel={`Mark ${s.title} ${done ? "not done" : "done"}`}
        style={{ width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" }}>
        <Icon name={done ? "check-circle" : "circle"} size={20} color={done ? colors.ok : colors.subtle} />
      </Pressable>
      <Pressable onPress={() => router.push({ pathname: "/task/[id]", params: { id: s.id } })} accessibilityRole="button" accessibilityLabel={`Open subtask ${s.title}`} style={{ flex: 1, paddingVertical: space.md, paddingRight: space.md }}>
        <Text style={{ color: done ? colors.subtle : colors.fg, textDecorationLine: done ? "line-through" : "none" }}>{s.title}</Text>
      </Pressable>
    </View>
  );
}
