import { useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { ActionSheet, type SheetOption } from "./action-sheet";
import { useAssignees, useTaskMutations } from "@/lib/queries";
import { TASK_MENU, command, commandTitle, createHandlers, type CommandId } from "@/lib/commands";
import { PRIORITIES, STATUSES, dayFrom, nextMonday, type Task } from "@/lib/tasks";
import { tick } from "@/lib/haptics";
import type { AssigneeId, TaskPatch } from "@/api/types";
import { colors, radius, space } from "@/theme";

type Field = "status" | "assignee" | "priority" | "label" | "due";

/**
 * R31: long-press on a task row. The first sheet lists the registry's task commands; each opens a
 * picker for that field. Changes save at once (optimistic, put back if the server says no).
 */
export function TaskActions({ task, knownLabels = [], onClose }: { task: Task | null; knownLabels?: string[]; onClose: () => void }) {
  const [field, setField] = useState<Field | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const assignees = useAssignees();
  const { update } = useTaskMutations();
  if (!task) return null;

  const close = () => { setField(null); setNewLabel(""); onClose(); };
  const save = (patch: TaskPatch) => {
    tick();
    update.mutate({ id: task.id, patch }, { onError: (e) => Alert.alert("That didn't save", e.message) });
    close();
  };
  const handlers = createHandlers({ navigate: () => {}, openWeb: () => {}, pickTaskField: (f) => setField(f) });

  if (!field) {
    const options: SheetOption[] = TASK_MENU.map((id) => ({ id, label: commandTitle(id), icon: command(id).icon }));
    return <ActionSheet visible title={task.title} subtitle={task.ref} options={options} testID="task-actions"
      onSelect={(id) => handlers[id as CommandId]({ taskId: task.id })} onClose={close} />;
  }

  const title = commandTitle(`task-${field}` as CommandId);
  let options: SheetOption[] = [];
  let pick: (id: string) => void = () => {};
  if (field === "status") {
    options = STATUSES.map((s) => ({ id: s.id, label: s.label, selected: task.status === s.id }));
    pick = (id) => save({ status: id as Task["status"] });
  } else if (field === "priority") {
    options = PRIORITIES.map((p) => ({ id: p.id, label: p.label, icon: "flag", selected: task.priority === p.id }));
    pick = (id) => save({ priority: id as Task["priority"] });
  } else if (field === "assignee") {
    options = [{ id: "none", label: "Nobody", icon: "user-x", selected: !task.assigneeId },
      ...(assignees.data ?? []).map((a): SheetOption => ({ id: a.id, label: a.type === "agent" ? `${a.name} (agent)` : a.name, icon: a.type === "agent" ? "cpu" : "user", selected: task.assigneeId === a.id }))];
    pick = (id) => save({ assigneeId: id === "none" ? null : (id as AssigneeId) });
  } else if (field === "due") {
    const today = dayFrom(0), tomorrow = dayFrom(1), monday = nextMonday();
    options = [
      { id: today, label: "Today", icon: "calendar", selected: task.due === today },
      { id: tomorrow, label: "Tomorrow", icon: "calendar", selected: task.due === tomorrow },
      { id: monday, label: "Next Monday", icon: "calendar", selected: task.due === monday },
      { id: "none", label: "No due date", icon: "x", selected: !task.due },
    ];
    pick = (id) => save({ due: id === "none" ? null : id });
  } else {
    const all = [...new Set([...task.labels, ...knownLabels])].sort((a, b) => a.localeCompare(b));
    options = all.map((l) => ({ id: l, label: l, icon: "tag", selected: task.labels.includes(l) }));
    pick = (id) => save({ labels: task.labels.includes(id) ? task.labels.filter((l) => l !== id) : [...task.labels, id] });
  }

  return (
    <ActionSheet visible title={title} subtitle={task.title} options={options} onSelect={pick} onClose={close} testID={`task-pick-${field}`}>
      {field === "label" ? (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          <TextInput value={newLabel} onChangeText={setNewLabel} placeholder="New label" placeholderTextColor={colors.subtle} accessibilityLabel="New label"
            returnKeyType="done" autoCapitalize="none" testID="new-label" maxLength={40}
            onSubmitEditing={() => { const l = newLabel.trim(); if (l && !task.labels.includes(l)) save({ labels: [...task.labels, l] }); }}
            style={{ color: colors.fg, fontSize: 16, minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingHorizontal: space.md, backgroundColor: colors.elevated }} />
        </View>
      ) : null}
    </ActionSheet>
  );
}
