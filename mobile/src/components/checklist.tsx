import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, Animated, PanResponder, Platform, Pressable, Text, TextInput, View, type AccessibilityActionEvent } from "react-native";
import * as Haptics from "expo-haptics";
import { Button, Field, Icon } from "@/components/ui";
import { useChecklist, useChecklistMutations } from "@/lib/checklist-queries";
import { cleanItemTitle, dragIds, dropIndex, moveIds, progressFraction, progressLabel, shiftFor } from "@/lib/checklist";
import { liftGesture, type LiftCallbacks } from "@/lib/drag";
import type { ChecklistItem } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

const GAP = space.sm;
/** A light tick as a row lifts and as it passes another row. Never throws (web, tests). */
const tick = () => {
  if (Platform.OS === "web" || typeof Haptics.selectionAsync !== "function") return;
  Haptics.selectionAsync().catch(() => {});
};
/** How long a finger rests on the handle before the row lifts. */
export const LIFT_MS = 200;

/**
 * R27: the checklist inside a task. Tap the circle to check an item, long press (or tap the dots) for
 * rename, move and delete. Every change shows at once and comes back if the server says no.
 * R29: long press the grip on the right and drag to reorder (core PanResponder and Animated only, so
 * it ships over the air). Screen readers get "Move up" and "Move down" actions on each item.
 */
export function ChecklistSection({ taskId, readOnly, onDragChange }: { taskId: string; readOnly?: boolean; onDragChange?: (dragging: boolean) => void }) {
  const q = useChecklist(taskId);
  const m = useChecklistMutations(taskId);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const items = q.data?.items ?? [];
  const count = q.data ? { total: q.data.total, done: q.data.done } : null;
  const label = progressLabel(count);
  const failed = (what: string) => (e: Error) => Alert.alert(what, e.message);
  const [heights, setHeights] = useState<number[]>([]);
  const [dragY] = useState(() => new Animated.Value(0));
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; height: number } | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  useEffect(() => {
    if (!orderError) return;
    const t = setTimeout(() => setOrderError(null), 5000);
    return () => clearTimeout(t);
  }, [orderError]);
  const reorder = (ids: string[]) => {
    setOrderError(null);
    m.reorder.mutate(ids, { onError: (e) => {
      setOrderError(`Order not saved. ${e.message}`);
      AccessibilityInfo.announceForAccessibility?.(`Order not saved. ${e.message}`);
    } });
  };
  const canDrag = !readOnly && items.length > 1;

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
    if (ids) reorder(ids);
  };
  const startDrag = (id: string, from: number) => {
    dragY.setValue(0);
    setOpen(null);
    setDrag({ id, from, to: from, height: heights[from] ?? 0 });
    onDragChange?.(true);
    tick();
  };
  const moveDrag = (dy: number) => {
    dragY.setValue(dy);
    setDrag((d) => {
      if (!d) return d;
      const to = dropIndex(heights.slice(0, items.length), GAP, d.from, dy);
      if (to !== d.to) tick();
      return to === d.to ? d : { ...d, to };
    });
  };
  const endDrag = (dy: number | null) => {
    const d = drag;
    setDrag(null);
    dragY.setValue(0);
    onDragChange?.(false);
    if (!d || dy === null) return;
    const ids = dragIds(items, d.from, dropIndex(heights.slice(0, items.length), GAP, d.from, dy));
    if (ids) reorder(ids);
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
          draggable={canDrag && !it.id.startsWith("chk_draft_") && editing?.id !== it.id}
          lifted={drag?.id === it.id} dragY={dragY}
          shift={drag ? shiftFor(n, drag.from, drag.to, drag.height, GAP) : 0}
          onMeasure={(h) => setHeights((prev) => (prev[n] === h ? prev : Object.assign([...prev], { [n]: h })))}
          onDragStart={() => startDrag(it.id, n)} onDragMove={moveDrag} onDragEnd={endDrag}
          editing={editing?.id === it.id ? editing.title : null}
          onToggle={() => m.toggle.mutate({ id: it.id, done: !it.done }, { onError: failed("That didn't save") })}
          onMenu={() => setOpen(open === it.id ? null : it.id)}
          onStartRename={() => setEditing({ id: it.id, title: it.title })}
          onEditText={(title) => setEditing({ id: it.id, title })}
          onSaveRename={saveRename}
          onMove={(dir) => move(it.id, dir)}
          onDelete={() => remove(it.id)} />
      ))}
      {orderError ? <Text style={{ color: colors.bad, fontSize: 13 }} accessibilityRole="alert" testID="checklist-order-error">{orderError}</Text> : null}
      {canDrag && items.length ? <Text style={font.tiny}>Hold the grip to drag an item into place.</Text> : null}
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

function Item({ it, first, last, open, readOnly, editing, draggable, lifted, dragY, shift, onMeasure, onDragStart, onDragMove, onDragEnd, onToggle, onMenu, onStartRename, onEditText, onSaveRename, onMove, onDelete }: {
  it: ChecklistItem; first: boolean; last: boolean; open: boolean; readOnly?: boolean; editing: string | null;
  draggable: boolean; lifted: boolean; dragY: Animated.Value; shift: number; onMeasure: (height: number) => void;
  onDragStart: () => void; onDragMove: (dy: number) => void; onDragEnd: (dy: number | null) => void;
  onToggle: () => void; onMenu: () => void; onStartRename: () => void; onEditText: (s: string) => void; onSaveRename: () => void;
  onMove: (dir: -1 | 1) => void; onDelete: () => void;
}) {
  const draft = it.id.startsWith("chk_draft_");
  const actions = readOnly || draft ? undefined : [
    ...(!first ? [{ name: "moveUp", label: "Move up" }] : []),
    ...(!last ? [{ name: "moveDown", label: "Move down" }] : []),
  ];
  const onAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === "moveUp" && !first) onMove(-1);
    if (e.nativeEvent.actionName === "moveDown" && !last) onMove(1);
  };
  return (
    <Animated.View onLayout={(e) => onMeasure(e.nativeEvent.layout.height)}
      style={{
        backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: lifted ? colors.brandLine : colors.line,
        transform: [{ translateY: lifted ? dragY : shift }, { scale: lifted ? 1.02 : 1 }],
        zIndex: lifted ? 10 : 0, elevation: lifted ? 6 : 0,
        shadowColor: "#000", shadowOpacity: lifted ? 0.18 : 0, shadowRadius: lifted ? 12 : 0, shadowOffset: { width: 0, height: lifted ? 6 : 0 },
      }}
      testID={`checklist-item-${it.id}`} accessibilityActions={actions} onAccessibilityAction={onAction}>
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
            accessibilityLabel={it.title} accessibilityHint={readOnly ? undefined : "Long press for rename, move and delete"}
            accessibilityActions={actions} onAccessibilityAction={onAction}>
            <Text style={{ color: it.done ? colors.subtle : colors.fg, fontSize: 16, textDecorationLine: it.done ? "line-through" : "none" }}>{it.title}</Text>
          </Pressable>
        )}
        {!readOnly ? (
          <Pressable onPress={onMenu} accessibilityRole="button" accessibilityLabel={`More for ${it.title}`} testID={`checklist-more-${it.id}`}
            style={{ width: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
            <Icon name="more-horizontal" size={18} color={colors.subtle} />
          </Pressable>
        ) : null}
        {draggable ? <DragHandle title={it.title} lifted={lifted} actions={actions} onAction={onAction} onStart={onDragStart} onMove={onDragMove} onEnd={onDragEnd} testID={`checklist-drag-${it.id}`} /> : null}
      </View>
      {open && !readOnly ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, paddingHorizontal: space.sm, paddingBottom: space.sm }}>
          <Action icon="edit-3" label="Rename" onPress={onStartRename} testID={`checklist-rename-btn-${it.id}`} />
          {!first ? <Action icon="chevron-up" label="Move up" onPress={() => onMove(-1)} testID={`checklist-up-${it.id}`} /> : null}
          {!last ? <Action icon="chevron-down" label="Move down" onPress={() => onMove(1)} testID={`checklist-down-${it.id}`} /> : null}
          <Action icon="trash-2" label="Delete" danger onPress={onDelete} testID={`checklist-delete-${it.id}`} />
        </View>
      ) : null}
    </Animated.View>
  );
}

/**
 * R29: the grip that lifts a row. A finger resting on it for LIFT_MS lifts the row; moving before
 * that lets the page scroll as usual. Built on PanResponder so no native gesture library is needed.
 */
function DragHandle({ title, lifted, actions, onAction, onStart, onMove, onEnd, testID }: {
  title: string; lifted: boolean; actions?: { name: string; label: string }[]; onAction: (e: AccessibilityActionEvent) => void;
  onStart: () => void; onMove: (dy: number) => void; onEnd: (dy: number | null) => void; testID?: string;
}) {
  // The gesture lives for the life of the row; the box always holds this render's callbacks.
  const latest = useRef<LiftCallbacks>({ onStart, onMove, onEnd });
  useLayoutEffect(() => { latest.current = { onStart, onMove, onEnd }; });
  // The ref is read inside the gesture's handlers (touch events), never during render.
  // eslint-disable-next-line react-hooks/refs
  const [gesture] = useState(() => liftGesture(() => latest.current, LIFT_MS));
  const [responder] = useState(() => PanResponder.create(gesture.handlers));
  useEffect(() => () => gesture.dispose(), [gesture]);
  return (
    <View {...responder.panHandlers} accessible accessibilityRole="button" accessibilityLabel={`Reorder ${title}`}
      accessibilityHint="Hold and drag to move. With a screen reader, use the actions to move up or down."
      accessibilityActions={actions} onAccessibilityAction={onAction} testID={testID}
      style={{ width: 44, minHeight: 48, alignItems: "center", justifyContent: "center", cursor: "grab" } as object}>
      <Icon name="grip-vertical" size={18} color={lifted ? colors.brand : colors.subtle} />
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
