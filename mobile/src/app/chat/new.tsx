import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { Avatar, Button, EmptyState, Field, Icon, Loading } from "@/components/ui";
import { useChatPeople, useStartDm } from "@/lib/queries";
import { colors, font, space } from "@/theme";
import { dmErrorText } from "@/lib/moderation";
import { tr } from "@/i18n";

/** Start a direct message with one or more teammates. Opens the existing DM if there is one. */
export default function NewDirectMessage() {
  const people = useChatPeople();
  const start = useStartDm();
  const [picked, setPicked] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  if (people.isPending) return <Loading />;
  if (people.error) return <EmptyState icon="alert-circle" title={tr("m.chat.couldn_t_load_your_team")} body={people.error.message} action={<Button label={tr("m.chat.try_again")} variant="secondary" onPress={() => people.refetch()} />} />;
  // A DM is between people, so agents are left out here; mention them in a channel instead.
  const f = filter.trim().toLowerCase();
  const list = people.data.filter((p) => p.type === "member" && (!f || p.name.toLowerCase().includes(f) || p.email.toLowerCase().includes(f)));
  const toggle = (id: string) => setPicked((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const go = () => start.mutate(picked.map((id) => id.replace(/^member:/, "")), {
    onSuccess: ({ channel }) => router.replace({ pathname: "/chat/[id]", params: { id: channel.id } }),
  });
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }} keyboardShouldPersistTaps="handled" testID="new-dm-screen">
      <Field label={tr("m.chat.to")} placeholder={tr("m.chat.search_your_team")} value={filter} onChangeText={setFilter} autoCapitalize="none" testID="dm-filter" />
      {list.length ? list.map((p) => {
        const on = picked.includes(p.id);
        return (
          <Pressable key={p.id} onPress={() => toggle(p.id)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={p.name} testID={`pick-${p.id}`}
            style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52, backgroundColor: pressed ? colors.hover : "transparent" })}>
            <Avatar name={p.name} size={34} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.fg, fontSize: 16 }}>{p.name}</Text>
              <Text style={font.tiny}>{p.email}</Text>
            </View>
            <Icon name={on ? "check-circle" : "circle"} size={22} color={on ? colors.brand : colors.subtle} />
          </Pressable>
        );
      }) : <Text style={font.small}>{tr("m.chat.no_one_matches_that")}</Text>}
      {start.error ? <Text style={{ color: colors.bad }} accessibilityRole="alert" testID="start-dm-error">{dmErrorText(start.error)}</Text> : null}
      <Button label={picked.length > 1 ? tr("m.chat.message_count_people", { count: picked.length }) : tr("m.chat.start_message")} onPress={go} disabled={!picked.length} loading={start.isPending} testID="start-dm" />
    </ScrollView>
  );
}
