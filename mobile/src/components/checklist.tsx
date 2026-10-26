import { useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { Button, Field, Icon } from "@/components/ui";
import { useChecklist, useChecklistMutations } from "@/lib/checklist-queries";
import { cleanItemTitle, moveIds, progressFraction, progressLabel } from "@/lib/checklist";
import type { ChecklistItem } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/**
 * R27: the checklist inside a task. Tap the circle to check an item, long press (or tap the dots) for
 * rename, move and delete. Every change shows at once and comes back if the server says no.
 */
export function ChecklistSection({ taskId, readOnly }: { taskId: string; readOnly?: boolean }) {
  const q = useChecklist(taskId);
  const m = useChecklistMutations(taskId);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const items = q.data?.items ?? [];
  const count = q.data ? { total: q.data.total, done: q.data.done } : null;
  const label = progressLabel(count);
  const failed = (what: string) => (e: Error) => Alert.alert(what, e.message);

  const add = () => {
    const title = cleanItemTitle(draft);
    if (!title) return;
    setDraft("");
    m.add.mutate(title, { onError: (e) => { setDraft(title); failed("Item not added")(e); } });
  };
  const saveRename = () => {
    if (!editing) return;
    const title = cleanItemTitle(editing.title);
    const before = items.find((i) => i.id === editing.id);
    setEditing(null);
    setOpen(null);
    if (title && before && title !== before.title) m.rename.mutate({ id: editing.id, title }, { onError: failed("Name not saved") });
  };
  const move = (id: string, dir: -1 | 1) => {
    const ids = moveIds(items, id, dir);
    if (ids) m.reorder.mutate(ids, { onError: failed("Order not saved") });
  };
  const remove = (id: string) => {
    setOpen(null);
    m.remove.mutate(id, { onError: failed("Item not deleted") });
  };

  return (
    <View style={{ gap: space.sm }} testID="checklist">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }} accessibilityRole="header">Checklist</Text>
        {label ? <Text style={font.tiny} testID="checklist-progress">{label}</Text> : null}
      </View>
      {count?.total ? (
        <View style={{ height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" }} accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: count.total, now: count.done }} accessibilityLabel={label ?? undefined}>
          <View style={{ height: 4, width: `${Math.round(progressFraction(count) * 100)}%`, backgroundColor: count.done === count.total ? colors.ok : colors.brand }} />
        </View>
      ) : null}
      {q.isError && !items.length ? <Text style={font.small}>{`Couldn't load the checklist. ${q.error.message}`}</Text> : null}
      {items.map((it, n) => (
        <Item key={it.id} it={it} first={n === 0} last={n === items.length - 1} open={open === it.id} readOnly={readOnly}
          editing={editing?.id === it.id ? editing.title : null}
          onToggle={() => m.toggle.mutate({ id: it.id, done: !it.done }, { onError: failed("That didn't save") })}
          onMenu={() => setOpen(open === it.id ? null : it.id)}
          onStartRename={() => setEditing({ id: it.id, title: it.title })}
          onEditText={(title) => setEditing({ id: it.id, title })}
          onSaveRename={saveRename}
          onMove={(dir) => move(it.id, dir)}
          onDelete={() => remove(it.id)} />
      ))}
      {!readOnly ? (
        <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-end" }}>
          <View style={{ flex: 1 }}>
            <Field label="Add an item" value={draft} onChangeText={setDraft} onSubmitEditing={add} returnKeyType="done" blurOnSubmit={false} testID="checklist-input" />
          </View>
          <Button label="Add" variant="secondary" onPress={add} disabled={!cleanItemTitle(draft)} style={{ minHeight: 48 }} testID="checklist-add" />
        </View>
      ) : null}
    </View>
  );
}

function Item({ it, first, last, open, readOnly, editing, onToggle, onMenu, onStartRename, onEditText, onSaveRename, onMove, onDelete }: {
  it: ChecklistItem; first: boolean; last: boolean; open: boolean; readOnly?: boolean; editing: string | null;
  onToggle: () => void; onMenu: () => void; onStartRename: () => void; onEditText: (s: string) => void; onSaveRename: () => void;
  onMove: (dir: -1 | 1) => void; onDelete: () => void;
}) {
  const draft = it.id.startsWith("chk_draft_");
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line }} testID={`checklist-item-${it.id}`}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Pressable onPress={onToggle} disabled={readOnly || draft} role="checkbox" aria-checked={it.done} accessibilityState={{ checked: it.done, disabled: readOnly || draft }}
          accessibilityLabel={`${it.title}, ${it.done ? "done" : "not done"}`} accessibilityHint={readOnly ? undefined : "Double tap to change"}
          testID={`checklist-toggle-${it.id}`} style={{ width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" }}>
          <Icon name={it.done ? "check-square" : "square"} size={20} color={it.done ? colors.ok : colors.subtle} />
        </Pressable>
        {editing !== null ? (
          <TextInput value={editing} onChangeText={onEditText} onSubmitEditing={onSaveRename} onBlur={onSaveRename} autoFocus returnKeyType="done"
            accessibilityLabel="Item name" testID={`checklist-rename-${it.id}`}
            style={{ flex: 1, minHeight: 44, color: colors.fg, fontSize: 16, paddingVertical: space.sm }} />
        ) : (
          <Pressable onPress={readOnly ? undefined : onToggle} onLongPress={readOnly ? undefined : onMenu} disabled={draft} style={{ flex: 1, paddingVertical: space.md }}
            accessibilityLabel={it.title} accessibilityHint={readOnly ? undefined : "Long press for rename, move and delete"}>
            <Text style={{ color: it.done ? colors.subtle : colors.fg, fontSize: 16, textDecorationLine: it.done ? "line-through" : "none" }}>{it.title}</Text>
          </Pressable>
        )}
        {!readOnly ? (
          <Pressable onPress={onMenu} accessibilityRole="button" accessibilityLabel={`More for ${it.title}`} testID={`checklist-more-${it.id}`}
            style={{ width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
            <Icon name="more-horizontal" size={18} color={colors.subtle} />
          </Pressable>
        ) : null}
      </View>
      {open && !readOnly ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, paddingHorizontal: space.sm, paddingBottom: space.sm }}>
          <Action icon="edit-3" label="Rename" onPress={onStartRename} testID={`checklist-rename-btn-${it.id}`} />
          {!first ? <Action icon="chevron-up" label="Move up" onPress={() => onMove(-1)} testID={`checklist-up-${it.id}`} /> : null}
          {!last ? <Action icon="chevron-down" label="Move down" onPress={() => onMove(1)} testID={`checklist-down-${it.id}`} /> : null}
          <Action icon="trash-2" label="Delete" danger onPress={onDelete} testID={`checklist-delete-${it.id}`} />
        </View>
      ) : null}
    </View>
  );
}

function Action({ icon, label, onPress, danger, testID }: { icon: "edit-3" | "chevron-up" | "chevron-down" | "trash-2"; label: string; onPress: () => void; danger?: boolean; testID?: string }) {
  const c = danger ? colors.bad : colors.brand;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 40, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.elevated }}>
      <Icon name={icon} size={16} color={c} />
      <Text style={{ color: c, fontSize: 15, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}
