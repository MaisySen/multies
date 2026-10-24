import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Badge, Banner, Button, Chip, EmptyState, Icon, IconButton, LargeTitle, Loading, Segmented } from "@/components/ui";
import { useTaskMutations, useTasks } from "@/lib/queries";
import { TimerChip } from "@/components/timer";
import { NotificationBell } from "@/components/notification-bell";
import { useOffline } from "@/lib/offline";
import { STATUSES, dueLabel, moveLabel, nextStatus, senderName, sortTasks, type Task, type TaskStatus } from "@/lib/tasks";
import { colors, radius, space } from "@/theme";

type Who = "all" | "me";

export default function Tasks() {
  const [view, setView] = useState<"list" | "board">("list");
  const [who, setWho] = useState<Who>("all");
  const tasks = useTasks(who === "me" ? { assignee: "me" } : {});
  const { update } = useTaskMutations();
  const offline = useOffline();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const move = (t: Task, status: TaskStatus) => update.mutate({ id: t.id, patch: { status } });
  const list = tasks.data ?? [];
  const col = Math.min(width * 0.82, 340);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LargeTitle title="Tasks" top={insets.top} right={(
        <>
          <NotificationBell />
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
        {offline ? <Banner text="You're offline. Showing the tasks saved on this phone." /> : null}
      </View>
      {tasks.isPending ? <Loading /> : tasks.isError && !list.length ? (
        <EmptyState icon="alert-circle" title="Couldn't load tasks" body={tasks.error.message} action={<Button label="Try again" icon="refresh-cw" onPress={() => tasks.refetch()} />} />
      ) : !list.length ? (
        <EmptyState icon="check-square" title={who === "me" ? "Nothing assigned to you" : "No tasks yet"} body="Open an email and tap Make a task, or add one here."
          action={<Button label="New task" icon="plus" onPress={() => router.push("/task/new")} />} />
      ) : view === "list" ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.lg }}
          refreshControl={<RefreshControl refreshing={tasks.isRefetching} onRefresh={() => { tasks.refetch(); }} tintColor={colors.brand} />}>
          {STATUSES.map((s) => {
            const rows = sortTasks(list.filter((t) => t.status === s.id));
            if (!rows.length) return null;
            return (
              <View key={s.id} style={{ gap: space.sm }}>
                <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }} accessibilityRole="header">{s.label} ({rows.length})</Text>
                {rows.map((t) => <TaskRow key={t.id} t={t} onToggle={() => move(t, t.status === "done" ? "todo" : "done")} />)}
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
                      <Pressable onPress={() => open(t)} accessibilityRole="button" accessibilityLabel={`${t.title}. ${s.label}`} style={{ gap: 6 }}>
                        <Text style={{ color: colors.subtle, fontSize: 12, fontWeight: "600" }}>{t.ref}</Text>
                        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>{t.title}</Text>
                        <Meta t={t} />
                      </Pressable>
                      <Button variant="ghost" label={moveLabel(t.status)} icon="arrow-right" testID={`move-${t.id}`}
                        onPress={() => move(t, nextStatus(t.status))} style={{ minHeight: 36, alignSelf: "flex-start", paddingHorizontal: 0 }} />
                    </View>
                  ))}
                  {!rows.length ? <Text style={{ color: colors.subtle, fontSize: 14, paddingVertical: space.md }}>Nothing here</Text> : null}
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const open = (t: Task) => router.push({ pathname: "/task/[id]", params: { id: t.id } });

/** Due date, priority, who has it and the email it came from, in one line of badges. */
export function Meta({ t }: { t: Task }) {
  const due = t.status === "done" ? null : dueLabel(t.due);
  const urgent = t.priority === "urgent" || t.priority === "high";
  const hasAny = due || urgent || t.assignee || t.source?.from || t.subtasks.total || t.commentCount;
  if (!hasAny) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {due ? <Badge label={due.text} tone={due.tone === "plain" ? "neutral" : due.tone} icon="calendar" /> : null}
      {urgent ? <Badge label={t.priority === "urgent" ? "Urgent" : "High"} tone={t.priority === "urgent" ? "bad" : "warn"} icon="flag" /> : null}
      {t.assignee ? <Badge label={t.assignee.name} icon={t.assignee.type === "agent" ? "cpu" : "user"} /> : null}
      {t.subtasks.total ? <Badge label={`${t.subtasks.done}/${t.subtasks.total}`} icon="list" /> : null}
      {t.commentCount ? <Badge label={String(t.commentCount)} icon="message-circle" /> : null}
      {t.source?.from ? <Text style={{ color: colors.subtle, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>From email: {senderName(t.source.from)}</Text> : null}
    </View>
  );
}

function TaskRow({ t, onToggle }: { t: Task; onToggle: () => void }) {
  const done = t.status === "done";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line }}>
      <Pressable onPress={onToggle} role="checkbox" aria-checked={done} accessibilityState={{ checked: done }} accessibilityLabel={`Mark ${t.title} ${done ? "not done" : "done"}`}
        testID={`toggle-${t.id}`} style={{ width: 52, minHeight: 56, alignItems: "center", justifyContent: "center" }}>
        <Icon name={done ? "check-circle" : "circle"} size={22} color={done ? colors.ok : colors.subtle} />
      </Pressable>
      <Pressable onPress={() => open(t)} accessibilityRole="button" accessibilityLabel={`Open task ${t.title}`}
        style={{ flex: 1, paddingVertical: space.md, paddingRight: space.lg, gap: 6 }}>
        <Text style={{ color: done ? colors.subtle : colors.fg, fontSize: 16, textDecorationLine: done ? "line-through" : "none" }}>{t.title}</Text>
        <Meta t={t} />
      </Pressable>
    </View>
  );
}
