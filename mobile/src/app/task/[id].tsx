import { useState } from "react";
import { Alert, Animated, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Avatar, Badge, Banner, Button, EmptyState, Icon, Loading, Segmented } from "@/components/ui";
import { GROUP, GroupRow, InsetGroup } from "@/components/grouped";
import { ActionSheet, type SheetOption } from "@/components/action-sheet";
import { SPRING, useReduceMotion } from "@/lib/motion";
import { success, tick, warning } from "@/lib/haptics";
import { TaskTime } from "@/components/timer";
import { StartMeetingButton } from "@/components/meetings";
import { CustomFields } from "@/components/custom-fields";
import { ChecklistSection } from "@/components/checklist";
import { TaskRuns } from "@/components/runs";
import { LinkedText } from "@/components/linked-text";
import { useAssignees, useTask, useTaskMutations } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { PRIORITIES, STATUSES, dayFrom, dayLabel, dueLabel, nextMonday, senderName } from "@/lib/tasks";
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
  // R29: the page holds still while a checklist item is being dragged.
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState<"priority" | "due" | "assignee" | null>(null);
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
    warning();
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

  const people_ = people.data ?? [];
  const who = t.assigneeId ? people_.find((p) => p.id === t.assigneeId) : null;
  const whoLabel = who ? (who.type === "agent" ? `${who.name} (agent)` : who.name) : "Nobody";
  const prio = PRIORITIES.find((p) => p.id === t.priority);
  const pickers: Record<"priority" | "due" | "assignee", { title: string; options: SheetOption[]; pick: (id: string) => void }> = {
    priority: { title: "Priority", options: PRIORITIES.map((p) => ({ id: p.id, label: p.label, icon: "flag", selected: t.priority === p.id })), pick: (v) => v !== t.priority && save({ priority: v as Task["priority"] }) },
    due: { title: "Due date", options: dueChoices.map((c) => ({ id: c.value ?? "none", label: c.label, icon: "calendar", selected: (t.due?.slice(0, 10) ?? null) === c.value })), pick: (v) => save({ due: v === "none" ? null : v }) },
    assignee: { title: "Assigned to", options: [{ id: "nobody", label: "Nobody", icon: "user", selected: !t.assigneeId }, ...people_.map((p) => ({ id: p.id, label: p.type === "agent" ? `${p.name} (agent)` : p.name, icon: (p.type === "agent" ? "bot" : "user") as SheetOption["icon"], selected: t.assigneeId === p.id }))],
      pick: (v) => { const next = v === "nobody" ? null : (v as AssigneeId); if (next !== t.assigneeId) save({ assigneeId: next }); } },
  };
  const sheet = picking ? pickers[picking] : null;
  const doneCount = d.subtasks.filter((s) => s.status === "done").length;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled" scrollEnabled={!dragging}>
      <Stack.Screen options={{ title: t.ref }} />
      {offline ? <Banner text="You're offline. This is the copy saved on this phone." /> : null}
      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Badge label={t.statusName} tone={t.status === "done" ? "ok" : t.status === "doing" ? "warn" : "neutral"} icon={t.status === "done" ? "check-circle" : "circle"} />
          {due && t.status !== "done" ? <Badge label={due.text} tone={due.tone === "plain" ? "neutral" : due.tone} icon="calendar" /> : null}
          {t.labels.map((l) => <Badge key={l} label={l} icon="tag" />)}
        </View>
        <TextInput value={title} onChangeText={setTitle} testID="task-title" accessibilityLabel="Title" multiline blurOnSubmit returnKeyType="done"
          placeholder="Task title" placeholderTextColor={colors.subtle} selectionColor={colors.brand}
          style={{ ...font.title, fontSize: 26, lineHeight: 32, paddingVertical: 4 }}
          onEndEditing={() => title.trim() && title !== t.title && save({ title: title.trim() }, true)} />
        <View accessibilityRole="radiogroup" accessibilityLabel="Status">
          <Segmented label="Status" value={t.status} options={STATUSES.map((s) => ({ id: s.id, label: s.label }))}
            onChange={(v) => { if (v === t.status) return; if (v === "done") success(); else tick(); save({ status: v }); }} />
        </View>
      </View>

      <InsetGroup header="Details">
        <GroupRow icon="flag" tile="orange" label="Priority" value={prio?.label ?? "None"} onPress={() => setPicking("priority")} testID="pick-priority" />
        <GroupRow icon="calendar" tile="red" label="Due" value={t.due ? dayLabel(t.due) : "No date"} onPress={() => setPicking("due")} testID="pick-due" />
        <GroupRow icon={who?.type === "agent" ? "bot" : "user"} tile="purple" label="Assigned to" value={whoLabel} onPress={() => setPicking("assignee")} testID="pick-assignee" />
      </InsetGroup>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md }}>
        <TaskTime task={t} detail={d} />
        <StartMeetingButton source={{ type: "task", id: t.id }} title={t.title} />
      </View>

      <InsetGroup header="Notes">
        <TextInput value={notes} onChangeText={setNotes} multiline accessibilityLabel="Notes" placeholder="Add notes" placeholderTextColor={colors.subtle} selectionColor={colors.brand}
          style={{ ...font.body, minHeight: 96, textAlignVertical: "top", padding: space.lg }}
          onEndEditing={() => notes !== t.notes && save({ notes }, true)} />
      </InsetGroup>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.lg }}>
        <ChecklistSection taskId={t.id} onDragChange={setDragging} />
        <TaskRuns taskId={t.id} />
        {d.customFields?.length ? (
          <Section title="Fields">
            <CustomFields fields={d.customFields} values={t.fields} people={people_} onSet={(fieldId, value) => save({ fields: { [fieldId]: value } })} />
          </Section>
        ) : null}
      </View>

      <InsetGroup header={`Subtasks${d.subtasks.length ? `, ${doneCount} of ${d.subtasks.length} done` : ""}`}>
        {d.subtasks.map((s) => <Subtask key={s.id} s={s} onToggle={() => { if (s.status !== "done") success(); else tick(); m.update.mutate({ id: s.id, patch: { status: s.status === "done" ? "todo" : "done" } }); }} />)}
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: GROUP.inset, paddingRight: space.sm, minHeight: GROUP.row, gap: space.md }}>
          <Icon name="plus" size={20} color={colors.brand} />
          <TextInput value={subtask} onChangeText={setSubtask} onSubmitEditing={addSubtask} returnKeyType="done" testID="subtask-input" accessibilityLabel="Add a subtask"
            placeholder="Add a subtask" placeholderTextColor={colors.subtle} selectionColor={colors.brand} style={{ ...font.body, flex: 1, paddingVertical: 12 }} />
          {subtask.trim() ? <Button label="Add" variant="ghost" onPress={addSubtask} loading={m.create.isPending} testID="add-subtask" /> : null}
        </View>
      </InsetGroup>

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.lg }}>
      {d.blockedBy?.length || d.blocking?.length ? (
        <Section title="Dependencies">
          {d.blockedBy?.map((b) => <Linked key={`by-${b.id}`} label="Blocked by" task={b} />)}
          {d.blocking?.map((b) => <Linked key={`bl-${b.id}`} label="Blocking" task={b} />)}
        </Section>
      ) : null}

      {t.source ? (
        <Section title={`Email thread${d.thread.length ? ` (${d.thread.length})` : ""}`}>
          {d.thread.length ? d.thread.map((r) => (
            <Pressable key={r.id} onPress={() => router.push({ pathname: "/thread/[id]", params: { id: r.id } })} accessibilityRole="button"
              accessibilityLabel={`Email from ${displayName(r.from)}, ${shortDate(r.date)}`}
              style={({ pressed }) => [{ backgroundColor: pressed ? colors.hover : colors.surface, borderRadius: GROUP.radius, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: space.md, gap: 6 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <Avatar name={displayName(r.from)} agent={r.byAgent} size={28} />
                <Text style={{ color: colors.fg, fontWeight: "600", flex: 1 }} numberOfLines={1}>{displayName(r.from)}</Text>
                {r.byAgent ? <Badge label="Agent" tone="brand" /> : r.direction === "outbound" ? <Badge label="Sent" /> : null}
                <Text style={font.tiny}>{shortDate(r.date)}</Text>
              </View>
              <Text style={[font.small, { color: colors.fg }]} numberOfLines={6}>{r.latestText || r.subject}</Text>
            </Pressable>
          )) : <Text style={font.small}>From {senderName(t.source.from) || "an email"}: {t.source.subject ?? ""}</Text>}
          {t.source.messageId ? (
            <Button variant="secondary" icon="mail" label="Open the email" testID="open-email"
              onPress={() => router.push({ pathname: "/thread/[id]", params: { id: t.source!.messageId! } })} />
          ) : null}
        </Section>
      ) : null}

      <Section title={`Comments${d.comments.length ? ` (${d.comments.length})` : ""}`}>
        {d.comments.map((c) => (
          <View key={c.id} style={{ flexDirection: "row", gap: space.md }}>
            <Avatar name={c.author.name ?? "?"} agent={c.author.type === "agent"} size={32} />
            <View style={{ flex: 1, gap: 4, backgroundColor: colors.surface, borderRadius: GROUP.radius, borderTopLeftRadius: 4, padding: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }}>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
                <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 15, flex: 1 }} numberOfLines={1}>{c.author.name ?? "Someone"}</Text>
                <Text style={font.tiny}>{shortDate(c.createdAt)}</Text>
              </View>
              <Text style={[font.body, { fontSize: 16 }]} selectable><LinkedText text={c.body} /></Text>
            </View>
          </View>
        ))}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, backgroundColor: colors.surface, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, paddingLeft: space.lg, paddingRight: 4, paddingVertical: 4 }}>
          <TextInput value={comment} onChangeText={setComment} multiline testID="comment-input" accessibilityLabel="Add a comment" placeholder="Add a comment"
            placeholderTextColor={colors.subtle} selectionColor={colors.brand} style={{ ...font.body, flex: 1, minHeight: 36, maxHeight: 140, paddingVertical: 8 }} />
          <Pressable onPress={() => { if (comment.trim()) { tick(); addComment(); } }} disabled={!comment.trim() || m.comment.isPending} testID="post-comment"
            accessibilityRole="button" accessibilityLabel="Post comment" accessibilityState={{ disabled: !comment.trim(), busy: m.comment.isPending }}
            style={({ pressed }) => [{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: comment.trim() ? colors.brandFill : colors.elevated, opacity: pressed ? 0.7 : 1 }]}>
            <Icon name="send" size={18} color={comment.trim() ? colors.brandFg : colors.subtle} />
          </Pressable>
        </View>
      </Section>
      </View>

      <InsetGroup footer={`Created ${longDate(t.createdAt)}${t.completedAt ? `. Done ${longDate(t.completedAt)}` : ""}`}>
        <GroupRow icon="trash-2" label="Delete task" destructive onPress={del} testID="delete-task" />
      </InsetGroup>

      <ActionSheet visible={!!sheet} title={sheet?.title ?? ""} options={sheet?.options ?? []} testID="task-picker"
        onSelect={(v) => { const p = sheet; setPicking(null); tick(); p?.pick(v); }} onClose={() => setPicking(null)} />
    </ScrollView>
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
  const reduce = useReduceMotion();
  const [pop] = useState(() => new Animated.Value(1));
  const press = () => {
    if (!reduce && !done) {
      pop.setValue(0.6);
      Animated.spring(pop, { toValue: 1, ...SPRING, useNativeDriver: true }).start();
    }
    onToggle();
  };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", minHeight: GROUP.row }}>
      <Pressable onPress={press} role="checkbox" aria-checked={done} accessibilityState={{ checked: done }} accessibilityLabel={`Mark ${s.title} ${done ? "not done" : "done"}`}
        testID={`subtask-check-${s.id}`} style={{ width: GROUP.inset + GROUP.tile + 4, minHeight: GROUP.row, alignItems: "center", justifyContent: "center" }}>
        <Animated.View style={{ transform: [{ scale: pop }] }}>
          <Icon name={done ? "check-circle" : "circle"} size={24} color={done ? colors.ok : colors.subtle} filled={done} />
        </Animated.View>
      </Pressable>
      <Pressable onPress={() => router.push({ pathname: "/task/[id]", params: { id: s.id } })} accessibilityRole="button" accessibilityLabel={`Open subtask ${s.title}`}
        style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", paddingVertical: space.md, paddingRight: GROUP.inset, gap: space.sm }, pressed && { opacity: 0.6 }]}>
        <Text style={{ ...font.body, flex: 1, color: done ? colors.subtle : colors.fg, textDecorationLine: done ? "line-through" : "none" }}>{s.title}</Text>
        <Icon name="chevron-right" size={16} color={colors.subtle} />
      </Pressable>
    </View>
  );
}

function Linked({ label, task }: { label: string; task: Task }) {
  return (
    <Pressable onPress={() => router.push({ pathname: "/task/[id]", params: { id: task.id } })} accessibilityRole="button" accessibilityLabel={`${label} ${task.ref} ${task.title}`}
      style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.md }}>
      <Text style={font.tiny}>{label}</Text>
      <Text style={{ color: colors.fg, flex: 1, textDecorationLine: task.status === "done" ? "line-through" : "none" }} numberOfLines={1}>{task.ref} {task.title}</Text>
    </Pressable>
  );
}
