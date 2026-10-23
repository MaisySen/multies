import { useState } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { router, Stack } from "expo-router";
import { Badge, Button, EmptyState, Icon, IconButton, Loading, Segmented } from "@/components/ui";
import { useTaskMutations, useTasks } from "@/lib/queries";
import { STATUSES, nextStatus, type Task, type TaskStatus } from "@/lib/tasks";
import { colors, radius, space } from "@/theme";

export default function Tasks() {
  const [view, setView] = useState<"list" | "board">("list");
  const tasks = useTasks();
  const { update } = useTaskMutations();
  const { width } = useWindowDimensions();
  const move = (t: Task, status: TaskStatus) => update.mutate({ id: t.id, patch: { status } });
  const list = tasks.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ headerRight: () => <IconButton icon="plus" label="New task" onPress={() => router.push("/task/new")} testID="new-task" /> }} />
      <View style={{ padding: space.lg, paddingBottom: space.sm, gap: space.md }}>
        <Segmented label="Task view" value={view} onChange={setView} options={[{ id: "list", label: "List" }, { id: "board", label: "Board" }]} />
        <Text style={{ color: colors.subtle, fontSize: 12 }}>Saved on this phone for now. Team tasks arrive with the next MyMail update.</Text>
      </View>
      {tasks.isPending ? <Loading /> : !list.length ? (
        <EmptyState icon="check-square" title="No tasks yet" body="Open an email and tap Make a task, or add one here."
          action={<Button label="New task" icon="plus" onPress={() => router.push("/task/new")} />} />
      ) : view === "list" ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.lg }}>
          {STATUSES.map((s) => {
            const rows = list.filter((t) => t.status === s.id);
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
        <ScrollView horizontal snapToInterval={Math.min(width * 0.82, 340) + space.md} decelerationRate="fast" contentContainerStyle={{ padding: space.lg, gap: space.md }}>
          {STATUSES.map((s) => {
            const rows = list.filter((t) => t.status === s.id);
            return (
              <View key={s.id} style={{ width: Math.min(width * 0.82, 340), backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.md, gap: space.sm }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ color: colors.fg, fontWeight: "700", fontSize: 16 }} accessibilityRole="header">{s.label}</Text>
                  <Badge label={String(rows.length)} />
                </View>
                {rows.map((t) => (
                  <View key={t.id} style={{ backgroundColor: colors.elevated, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
                    <Pressable onPress={() => router.push({ pathname: "/task/[id]", params: { id: t.id } })} accessibilityRole="button" accessibilityLabel={`${t.title}. ${s.label}`} style={{ gap: 4 }}>
                      <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>{t.title}</Text>
                      {t.source ? <Text style={{ color: colors.subtle, fontSize: 12 }} numberOfLines={1}>From email: {t.source.from}</Text> : null}
                    </Pressable>
                    <Button variant="ghost" label={`Move to ${STATUSES.find((x) => x.id === nextStatus(t.status))!.label}`} icon="arrow-right"
                      onPress={() => move(t, nextStatus(t.status))} style={{ minHeight: 36, alignSelf: "flex-start", paddingHorizontal: 0 }} />
                  </View>
                ))}
                {!rows.length ? <Text style={{ color: colors.subtle, fontSize: 14, paddingVertical: space.md }}>Nothing here</Text> : null}
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function TaskRow({ t, onToggle }: { t: Task; onToggle: () => void }) {
  const done = t.status === "done";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line }}>
      <Pressable onPress={onToggle} role="checkbox" aria-checked={done} accessibilityState={{ checked: done }} accessibilityLabel={`Mark ${t.title} ${done ? "not done" : "done"}`}
        style={{ width: 52, minHeight: 56, alignItems: "center", justifyContent: "center" }}>
        <Icon name={done ? "check-circle" : "circle"} size={22} color={done ? colors.ok : colors.subtle} />
      </Pressable>
      <Pressable onPress={() => router.push({ pathname: "/task/[id]", params: { id: t.id } })} accessibilityRole="button" accessibilityLabel={`Open task ${t.title}`}
        style={{ flex: 1, paddingVertical: space.md, paddingRight: space.lg, gap: 2 }}>
        <Text style={{ color: done ? colors.subtle : colors.fg, fontSize: 16, textDecorationLine: done ? "line-through" : "none" }}>{t.title}</Text>
        {t.source ? <Text style={{ color: colors.subtle, fontSize: 12 }} numberOfLines={1}>From email: {t.source.from}</Text> : null}
        {t.status === "doing" ? <Badge label="Doing" tone="warn" /> : null}
      </Pressable>
    </View>
  );
}
