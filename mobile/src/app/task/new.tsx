import { useMemo, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { success, warning } from "@/lib/haptics";
import { router } from "expo-router";
import { Badge, Button, Field } from "@/components/ui";
import { useAssignees, useProjects, useTaskMutations } from "@/lib/queries";
import { parseQuickAdd, quickAddToTask } from "@/lib/quick-add";
import { colors, font, space } from "@/theme";

export default function NewTask() {
  const { create } = useTaskMutations();
  const projects = useProjects();
  const assignees = useAssignees();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  // R34: quick add. "Call Ana tomorrow 3pm @ana #ops !high" sets the due date, person, project and
  // priority; the chips under the title show what was understood before you save.
  const parsed = useMemo(() => parseQuickAdd(title), [title]);
  const resolved = useMemo(() => quickAddToTask(parsed, projects.data ?? [], assignees.data ?? []), [parsed, projects.data, assignees.data]);
  // R33: the task shows in the list at once (with a Saving tint) and this sheet closes; if the save
  // fails the row goes away again and an alert says why.
  const save = () => {
    if (!title.trim()) { setError("Add a title first."); warning(); return; }
    const { unmatched: _unmatched, ...fields } = resolved;
    create.mutate({ ...fields, title: fields.title || title.trim(), notes }, {
      onSuccess: () => success(),
      onError: (e) => { warning(); Alert.alert("Couldn't add the task", (e as Error).message); },
    });
    if (router.canGoBack()) router.back();
  };
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
      <Field label="Title" testID="task-title" value={title} onChangeText={setTitle} autoFocus placeholder="Call Jordan tomorrow 3pm #ops !high" returnKeyType="done" onSubmitEditing={save} />
      {parsed.chips.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: -space.sm }} testID="quick-add-chips" accessibilityLabel={`Understood: ${parsed.chips.map((c) => c.text).join(", ")}`}>
          {parsed.chips.map((c) => (
            <Badge key={`${c.kind}-${c.text}`} label={c.text} tone={resolved.unmatched.includes(c.text) ? "warn" : "brand"}
              icon={c.kind === "date" ? "calendar" : c.kind === "time" ? "clock" : c.kind === "person" ? "user" : c.kind === "project" ? "project" : "flag"} />
          ))}
        </View>
      ) : (
        <Text style={[font.tiny, { marginTop: -space.sm }]}>Type a date, @person, #project or !priority to set them.</Text>
      )}
      <Field label="Notes" value={notes} onChangeText={setNotes} multiline style={{ minHeight: 100, textAlignVertical: "top", paddingTop: 12 }} />
      {error ? <Text style={{ color: colors.bad }} accessibilityRole="alert">{error}</Text> : null}
      <Button label="Add task" icon="plus" onPress={save} loading={create.isPending} testID="save-task" />
    </ScrollView>
  );
}
