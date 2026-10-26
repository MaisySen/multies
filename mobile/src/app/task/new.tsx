import { useState } from "react";
import { Alert, ScrollView, Text } from "react-native";
import { success, warning } from "@/lib/haptics";
import { router } from "expo-router";
import { Button, Field } from "@/components/ui";
import { useTaskMutations } from "@/lib/queries";
import { colors, space } from "@/theme";

export default function NewTask() {
  const { create } = useTaskMutations();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  // R33: the task shows in the list at once (with a Saving tint) and this sheet closes; if the save
  // fails the row goes away again and an alert says why.
  const save = () => {
    if (!title.trim()) { setError("Add a title first."); warning(); return; }
    create.mutate({ title: title.trim(), notes }, {
      onSuccess: () => success(),
      onError: (e) => { warning(); Alert.alert("Couldn't add the task", (e as Error).message); },
    });
    if (router.canGoBack()) router.back();
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
