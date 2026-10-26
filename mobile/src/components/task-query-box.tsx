import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Chip, Icon } from "@/components/ui";
import { QUERY_SUGGESTIONS, hasTerm, normaliseQuery, toggleTerm } from "@/lib/task-query";
import { colors, font, radius, space } from "@/theme";

/**
 * R27: a search box for the task query language (assignee:me due:<7d label:bug status:doing), with
 * tappable starters. The query runs when the person submits or taps a chip; a query the server
 * refuses shows its message under the box.
 */
export function TaskQueryBox({ value, onSubmit, error }: { value: string; onSubmit: (q: string) => void; error?: string | null }) {
  const [text, setText] = useState(value);
  // Follow the applied query when it changes from outside (a chip, the remembered query), without an effect.
  const [seen, setSeen] = useState(value);
  if (value !== seen) { setSeen(value); setText(value); }
  const run = (q: string) => { const v = normaliseQuery(q); setText(v); onSubmit(v); };

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.md,
        backgroundColor: colors.elevated, borderWidth: error ? 1 : 0, borderColor: error ? colors.bad : "transparent" }}>
        <Icon name="search" size={18} color={colors.subtle} />
        <TextInput value={text} onChangeText={setText} onSubmitEditing={() => run(text)} returnKeyType="search" autoCapitalize="none" autoCorrect={false}
          placeholder="Search, or try assignee:me due:<7d" placeholderTextColor={colors.subtle} accessibilityLabel="Search tasks"
          accessibilityHint="Words, or keys like label:bug and status:doing" testID="task-query"
          style={{ flex: 1, color: colors.fg, fontSize: 16, paddingVertical: space.sm }} />
        {text ? (
          <Pressable onPress={() => run("")} accessibilityRole="button" accessibilityLabel="Clear search" testID="task-query-clear"
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}>
            <Icon name="x" size={16} color={colors.subtle} />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text style={[font.small, { color: colors.bad }]} accessibilityLiveRegion="polite" testID="task-query-error">{error}</Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }} keyboardShouldPersistTaps="handled">
        {QUERY_SUGGESTIONS.map((s) => (
          <Chip key={s.term} label={s.label} selected={hasTerm(value, s.term)} onPress={() => run(toggleTerm(value, s.term))} />
        ))}
      </ScrollView>
    </View>
  );
}
