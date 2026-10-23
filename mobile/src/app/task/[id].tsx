import { useEffect, useState } from "react";
import { Alert, Platform, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Chip, EmptyState, Field, Loading } from "@/components/ui";
import { useTaskMutations, useTasks } from "@/lib/queries";
import { STATUSES } from "@/lib/tasks";
import { longDate } from "@/lib/format";
import { colors, font, space } from "@/theme";

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tasks = useTasks();
  const { update, remove } = useTaskMutations();
  const t = tasks.data?.find((x) => x.id === id);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => { if (t) { setTitle(t.title); setNotes(t.notes); } }, [t?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (tasks.isPending) return <Loading />;
  if (!t) return <EmptyState icon="check-square" title="Task not found" body="It may have been deleted." />;

  const del = () => {
    const go = () => remove.mutate(t.id, { onSuccess: () => router.back() });
    if (Platform.OS === "web") return go();
    Alert.alert("Delete this task?", undefined, [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: go }]);
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Title" value={title} onChangeText={setTitle} onEndEditing={() => title.trim() && title !== t.title && update.mutate({ id: t.id, patch: { title: title.trim() } })} />
      <View style={{ gap: 6 }}>
        <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>Status</Text>
        <View style={{ flexDirection: "row", gap: space.sm }} accessibilityRole="radiogroup" accessibilityLabel="Status">
          {STATUSES.map((s) => <Chip key={s.id} label={s.label} selected={t.status === s.id} onPress={() => update.mutate({ id: t.id, patch: { status: s.id } })} />)}
        </View>
      </View>
      <Field label="Notes" value={notes} onChangeText={setNotes} multiline style={{ minHeight: 120, textAlignVertical: "top", paddingTop: 12 }}
        onEndEditing={() => notes !== t.notes && update.mutate({ id: t.id, patch: { notes } })} />
      {t.source ? (
        <Button variant="secondary" icon="mail" label={`Open the email from ${t.source.from}`}
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: t.source!.messageId } })} />
      ) : null}
      <Text style={font.tiny}>Created {longDate(t.createdAt)}</Text>
      <Button variant="danger" icon="trash-2" label="Delete task" onPress={del} />
    </ScrollView>
  );
}
