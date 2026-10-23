import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { router } from "expo-router";
import { Button, Field } from "@/components/ui";
import { useTaskMutations } from "@/lib/queries";
import { colors, space } from "@/theme";

export default function NewTask() {
  const { create } = useTaskMutations();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try { await create.mutateAsync({ title, notes }); router.back(); }
    catch (e) { setError((e as Error).message); }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Title" testID="task-title" value={title} onChangeText={setTitle} autoFocus placeholder="Call Jordan about the fit out quote" returnKeyType="done" onSubmitEditing={save} />
      <Field label="Notes" value={notes} onChangeText={setNotes} multiline style={{ minHeight: 100, textAlignVertical: "top", paddingTop: 12 }} />
      {error ? <Text style={{ color: colors.bad }} accessibilityRole="alert">{error}</Text> : null}
      <Button label="Add task" icon="plus" onPress={save} loading={create.isPending} testID="save-task" />
    </ScrollView>
  );
}
