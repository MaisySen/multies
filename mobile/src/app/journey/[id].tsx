/**
 * M1 (1.10.9): one journey: on or paused, who is waiting and each email's counts, with Pause and Start where the server allows.
 */
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Button, EmptyState, Loading } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Footnote, LoadError, NoAccess } from "@/components/m1-work";
import { confirmThen, problemText, WebNote } from "@/components/m1-more";
import { noAccess, notFoundErr } from "@/lib/contacts-queries";
import { useJourney, useJourneyAction } from "@/lib/m1-more-queries";
import { journeyActions, journeyStatusOf, MERGE_WEB } from "@/lib/mail-merge";
import { colors, font, space } from "@/theme";

export default function JourneyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useJourney(id);
  const act = useJourneyAction(id ?? "");
  const header = <Stack.Screen options={{ title: q.data?.name || "Journey" }} />;

  if (noAccess(q.error)) return <>{header}<NoAccess what="Mail merge" /></>;
  if (q.isPending) return <>{header}<Loading label="Loading journey" rows={4} /></>;
  if (notFoundErr(q.error)) return <>{header}<EmptyState icon="send" title="Journey not found" body="It may have been deleted." art={null} /></>;
  if (q.error || !q.data) return <>{header}<LoadError title="Couldn't load this journey" error={q.error} onRetry={() => q.refetch()} /></>;

  const j = q.data;
  const can = journeyActions(j);
  const st = journeyStatusOf(j.status);
  const run = (a: "pause" | "start") => act.mutate(a, { onError: (e) => Alert.alert(a === "pause" ? "Couldn't pause" : "Couldn't start", problemText(e)) });

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl, gap: space.lg }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="journey-detail">
      {header}
      <View style={{ paddingHorizontal: space.lg, gap: space.xs }}>
        <Text style={font.heading} accessibilityRole="header" testID="journey-name">{j.name}</Text>
        {j.listName ? <Text style={font.small}>List: {j.listName}</Text> : null}
      </View>
      <InsetGroup>
        <GroupRow icon="send" tile="purple" label="Status" value={st.label} testID="journey-status" />
        <GroupRow icon="users" tile="teal" label="Enrolled so far" value={String(j.enrolled)} />
        <GroupRow icon="clock" tile="orange" label="Waiting for their next email" value={String(j.active ?? 0)} />
        <GroupRow icon="mail" tile="blue" label="Emails in the journey" value={String(j.steps.length)} />
      </InsetGroup>
      {j.stepStats?.length ? (
        <InsetGroup header="Each email" testID="journey-steps">
          {j.stepStats.map((s, i) => (
            <GroupRow key={`${s.name}-${i}`} icon="mail" label={s.name} sub={`${s.sent} sent, ${s.opened} opened, ${s.clicked} clicked`} />
          ))}
        </InsetGroup>
      ) : null}
      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        {can.pause ? <Button label="Pause journey" icon="pause" variant="secondary" loading={act.isPending}
          onPress={() => confirmThen("Pause this journey?", "No one gets their next email until you start it again. New people still join the list.", "Pause", () => run("pause"))} testID="journey-pause" /> : null}
        {can.start ? <Button label={j.status === "paused" ? "Start again" : "Start journey"} icon="play" loading={act.isPending}
          onPress={() => confirmThen("Start this journey?", "Emails go out to people on the list as each step comes due.", "Start", () => run("start"))} testID="journey-start" /> : null}
        {j.canSend === false ? <Footnote testID="journey-no-send">Only admins can start or pause a journey on a list shared with the whole workspace.</Footnote> : null}
      </View>
      <WebNote text="Edit the emails and timing on the web." path={`${MERGE_WEB}/journeys/${encodeURIComponent(j.id)}`} />
    </ScrollView>
  );
}
