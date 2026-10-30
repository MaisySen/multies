import { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useCollapse } from "@/components/chrome";
import { Badge, Banner, Button, Chip, EmptyState, Icon, IconButton, LargeTitle, Loading, Segmented } from "@/components/ui";
import { useTaskMutations, useTasks } from "@/lib/queries";
import { TimerChip } from "@/components/timer";
import { NotificationBell } from "@/components/notification-bell";
import { TaskActions } from "@/components/task-actions";
import { openCommandSheet } from "@/lib/command-sheet-store";
import { tick, warning } from "@/lib/haptics";
import { SwipeHint, SwipeRow, type SwipeAction } from "@/components/swipe-row";
import { UndoToast } from "@/components/undo-toast";
import { useUndoQueue } from "@/lib/undo-queue";
import { usePrefs, type TaskSwipe } from "@/lib/prefs";
import { isTempId } from "@/lib/pending";
import { useOffline } from "@/lib/offline";
import { kv } from "@/lib/kv";
import { progressBadge } from "@/lib/checklist";
import { loadLastQuery, queryErrorText, saveLastQuery } from "@/lib/task-query";
import { TaskQueryBox } from "@/components/task-query-box";
import { STATUSES, dueLabel, moveLabel, nextStatus, senderName, sortTasks, type Task, type TaskStatus } from "@/lib/tasks";
import { colors, radius, space } from "@/theme";

type Who = "all" | "me";

export default function Tasks() {
  const [view, setView] = useState<"list" | "board">("list");
  const [who, setWho] = useState<Who>("all");
  // R27: the query box. The last query is remembered on this phone.
  const [query, setQuery] = useState("");
  useEffect(() => { let live = true; loadLastQuery(kv()).then((q) => { if (live && q) setQuery(q); }); return () => { live = false; }; }, []);
  const applyQuery = (q: string) => { setQuery(q); saveLastQuery(kv(), q); };
  const tasks = useTasks({ ...(who === "me" ? { assignee: "me" as const } : {}), ...(query ? { q: query } : {}) });
  const queryError = queryErrorText(tasks.error, query);
  const { update, remove } = useTaskMutations();
  const offline = useOffline();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const onFail = { onError: () => warning() };
  const move = (t: Task, status: TaskStatus) => update.mutate({ id: t.id, patch: { status } }, onFail);
  // R33: complete, delete and move hide or change at once with Undo; the call runs when the window closes.
  const undo = useUndoQueue();
  const prefs = usePrefs();
  const completeLater = (t: Task) => undo.push(t.id, t.status === "done" ? "Marked not done" : "Completed", () => move(t, t.status === "done" ? "todo" : "done"));
  const deleteLater = (t: Task) => undo.push(t.id, "Task deleted", () => remove.mutate(t.id, onFail));
  const moveLater = (t: Task, status: TaskStatus) => undo.push(t.id, `Moved to ${STATUSES.find((s) => s.id === status)?.label ?? status}`, () => move(t, status));
  const swipeFor = (t: Task, choice: TaskSwipe): SwipeAction | undefined => {
    switch (choice) {
      case "complete": return { label: t.status === "done" ? "Not done" : "Complete", icon: "check-circle", color: colors.ok, onAction: () => completeLater(t) };
      case "schedule": return { label: "Schedule", icon: "calendar", color: colors.warn, onAction: () => setActionsFor(t) };
      case "delete": return { label: "Delete", icon: "trash-2", color: colors.bad, onAction: () => deleteLater(t) };
      default: return undefined;
    }
  };
  const list = (tasks.data ?? []).filter((x) => !undo.hidden.has(x.id));
  const col = Math.min(width * 0.82, 340);
  // R31: long-press a task for Status, Assignee, Priority, Label and Due date (the registry's task commands).
  const [actionsFor, setActionsFor] = useState<Task | null>(null);
  const knownLabels = [...new Set(list.flatMap((t) => t.labels ?? []))];
  const longPress = (t: Task) => { tick(); setActionsFor(t); };
  const collapse = useCollapse(); // R34: large title folds on scroll

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LargeTitle title="Tasks" top={insets.top} collapsed={collapse.collapsed} right={(
        <>
          <NotificationBell />
          <IconButton icon="command" label="Commands" onPress={openCommandSheet} testID="open-commands" />
          <IconButton icon="video" label="Meetings" onPress={() => router.push("/meetings")} testID="open-meetings" />
          <IconButton icon="plus" label="New task" onPress={() => router.push("/task/new")} testID="new-task" />
        </>
      )} />
      <View style={{ padding: space.lg, paddingBottom: space.sm, gap: space.md }}>
        <TimerChip />
        <Segmented label="Task view" value={view} onChange={setView} options={[{ id: "list", label: "List" }, { id: "board", label: "Board" }]} />
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Chip label="All tasks" selected={who === "all"} onPress={() => setWho("all")} />
          <Chip label="Assigned to me" selected={who === "me"} onPress={() => setWho("me")} />
        </View>
        <TaskQueryBox value={query} onSubmit={applyQuery} error={queryError} />
        {offline ? <Banner text="You're offline. Showing the tasks saved on this phone." /> : null}
      </View>
      {tasks.isPending ? <Loading variant="task" label="Loading tasks" /> : queryError ? (
        <EmptyState icon="search" title="Check the search" body="Fix the part named above, or clear the search." />
      ) : tasks.isError && !list.length ? (
        <EmptyState icon="alert-circle" title="Couldn't load tasks" body={tasks.error.message} action={<Button label="Try again" icon="refresh-cw" onPress={() => tasks.refetch()} />} />
      ) : !list.length && query ? (
        <EmptyState icon="search" title="No tasks match" body={`Nothing matches ${query}.`} action={<Button label="Clear search" icon="x" onPress={() => applyQuery("")} />} />
      ) : !list.length ? (
        <EmptyState icon="check-square" title={who === "me" ? "Nothing assigned to you" : "No tasks yet"} body="Open an email and tap Make a task, or add one here."
          action={<Button label="New task" icon="plus" onPress={() => router.push("/task/new")} />} />
      ) : view === "list" ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.lg }} {...collapse.scrollProps}
          refreshControl={<RefreshControl refreshing={tasks.isRefetching} onRefresh={() => { tasks.refetch(); }} tintColor={colors.brand} />}>
          <View style={{ marginHorizontal: -space.lg }}><SwipeHint testID="task-swipe-hint" /></View>
          {STATUSES.map((s) => {
            const rows = sortTasks(list.filter((t) => t.status === s.id));
            if (!rows.length) return null;
            return (
              <View key={s.id} style={{ gap: space.sm }}>
                <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }} accessibilityRole="header">{s.label} ({rows.length})</Text>
                {rows.map((t) => (
                  <SwipeRow key={t.id} testID={`swipe-task-${t.id}`}
                    right={swipeFor(t, prefs.taskSwipes.rightShort)} rightLong={swipeFor(t, prefs.taskSwipes.rightLong)}
                    left={swipeFor(t, prefs.taskSwipes.leftShort)} leftLong={swipeFor(t, prefs.taskSwipes.leftLong)}>
                    <TaskRow t={t} onToggle={() => { tick(); move(t, t.status === "done" ? "todo" : "done"); }} onLongPress={() => longPress(t)} />
                  </SwipeRow>
                ))}
              </View>
            );
          })}
        </ScrollView>
      ) : (
        <ScrollView horizontal snapToInterval={col + space.md} decelerationRate="fast" contentContainerStyle={{ padding: space.lg, gap: space.md }}>
          {STATUSES.map((s) => {
            const rows = sortTasks(list.filter((t) => t.status === s.id));
            return (
              <View key={s.id} testID={`column-${s.id}`} style={{ width: col, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: space.sm }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: colors.fg, fontWeight: "700", fontSize: 16 }} accessibilityRole="header">{s.label}</Text>
                  <Badge label={String(rows.length)} />
                </View>
                <ScrollView contentContainerStyle={{ gap: space.sm }} showsVerticalScrollIndicator={false}>
                  {rows.map((t) => (
                    <View key={t.id} style={{ backgroundColor: colors.elevated, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
                      <Pressable onPress={() => open(t)} onLongPress={() => longPress(t)} delayLongPress={350} accessibilityRole="button" accessibilityLabel={`${t.title}. ${s.label}`} accessibilityHint="Long press for more actions" style={{ gap: 6 }}>
                        <Text style={{ color: colors.subtle, fontSize: 12, fontWeight: "600" }}>{t.ref}</Text>
                        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>{t.title}</Text>
                        <Meta t={t} />
                      </Pressable>
                      <Button variant="ghost" label={moveLabel(t.status)} icon="arrow-right" testID={`move-${t.id}`}
                        onPress={() => { tick(); moveLater(t, nextStatus(t.status)); }} style={{ minHeight: 36, alignSelf: "flex-start", paddingHorizontal: 0 }} />
                    </View>
                  ))}
                  {!rows.length ? <Text style={{ color: colors.subtle, fontSize: 14, paddingVertical: space.md }}>Nothing here</Text> : null}
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>
      )}
      <TaskActions task={actionsFor} knownLabels={knownLabels} onClose={() => setActionsFor(null)} />
      <UndoToast pending={undo.newest} onUndo={undo.undo} />
    </View>
  );
}

const open = (t: Task) => router.push({ pathname: "/task/[id]", params: { id: t.id } });

/** Due date, priority, who has it and the email it came from, in one line of badges. */
export function Meta({ t }: { t: Task }) {
  const due = t.status === "done" ? null : dueLabel(t.due);
  const urgent = t.priority === "urgent" || t.priority === "high";
  const checklist = progressBadge(t.checklist);
  const hasAny = due || urgent || t.assignee || t.source?.from || t.subtasks.total || t.commentCount || checklist;
  if (!hasAny) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {due ? <Badge label={due.text} tone={due.tone === "plain" ? "neutral" : due.tone} icon="calendar" /> : null}
      {urgent ? <Badge label={t.priority === "urgent" ? "Urgent" : "High"} tone={t.priority === "urgent" ? "bad" : "warn"} icon="flag" /> : null}
      {t.assignee ? <Badge label={t.assignee.name} icon={t.assignee.type === "agent" ? "cpu" : "user"} /> : null}
      {t.subtasks.total ? <Badge label={`${t.subtasks.done}/${t.subtasks.total}`} icon="list" /> : null}
      {checklist ? <Badge label={checklist} icon="check-square" tone={t.checklist!.done === t.checklist!.total ? "ok" : "neutral"} /> : null}
      {t.commentCount ? <Badge label={String(t.commentCount)} icon="message-circle" /> : null}
      {t.source?.from ? <Text style={{ color: colors.subtle, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>From email: {senderName(t.source.from)}</Text> : null}
    </View>
  );
}

function TaskRow({ t, onToggle, onLongPress }: { t: Task; onToggle: () => void; onLongPress?: () => void }) {
  const done = t.status === "done";
  // R33: a task still being saved shows a soft blue tint and "Saving" until the server has it.
  const saving = isTempId(t.id);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: saving ? colors.brandSoft : colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: saving ? colors.brandLine : colors.line }}
      accessibilityState={{ busy: saving }} testID={saving ? "task-row-saving" : undefined}>
      <Pressable onPress={onToggle} role="checkbox" aria-checked={done} accessibilityState={{ checked: done }} accessibilityLabel={`Mark ${t.title} ${done ? "not done" : "done"}`}
        testID={`toggle-${t.id}`} style={{ width: 52, minHeight: 56, alignItems: "center", justifyContent: "center" }}>
        <Icon name={done ? "check-circle" : "circle"} size={22} color={done ? colors.ok : colors.subtle} />
      </Pressable>
      <Pressable onPress={() => open(t)} onLongPress={onLongPress} delayLongPress={350} accessibilityRole="button" accessibilityLabel={`Open task ${t.title}`}
        accessibilityHint="Long press for more actions" testID={`task-row-${t.id}`} style={{ flex: 1, paddingVertical: space.md, paddingRight: space.lg, gap: 6 }}>
        <Text style={{ color: done ? colors.subtle : colors.fg, fontSize: 16, textDecorationLine: done ? "line-through" : "none" }}>{t.title}</Text>
        {saving ? <Text style={{ color: colors.brand, fontSize: 12, fontWeight: "600" }}>Saving</Text> : <Meta t={t} />}
      </Pressable>
    </View>
  );
}
