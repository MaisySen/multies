import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { meetingDays } from "@/lib/meetings";
import { Banner, Button, EmptyState, IconButton, Loading } from "@/components/ui";
import { MeetingCard, StartMeetingButton } from "@/components/meetings";
import { useMeetings } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useNow } from "@/lib/time";
import { colors, lh, space } from "@/theme";
import { tr } from "@/i18n";

/** Upcoming meetings. Video runs on the web meeting page, which Join opens. MPAR3: Notes on each, Calendar up top. */
export default function Meetings() {
  const q = useMeetings();
  const offline = useOffline();
  const now = useNow(false);
  const header = <Stack.Screen options={{ title: tr("m.m3x.meetings"), headerRight: () => <IconButton icon="calendar" label={tr("m.cal.title")} onPress={() => router.push("/calendar")} testID="meetings-calendar" /> }} />;
  if (q.isPending) return <>{header}<Loading /></>;
  if (q.error) return <>{header}<EmptyState icon="alert-circle" title={tr("m.m3x.meetings_failed")} body={q.error.message} action={<Button label={tr("common.try_again")} variant="secondary" onPress={() => q.refetch()} />} /></>;
  const list = [...q.data.meetings].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="meetings-screen">
      {header}
      {offline ? <Banner text={tr("m.m3x.meetings_offline")} /> : null}
      {!q.data.videoEnabled ? <Banner tone="neutral" icon="info" text={tr("m.m3x.video_off")} /> : null}
      <StartMeetingButton title={tr("m.m3x.quick_meeting")} testID="start-meeting-now" />
      {list.length ? meetingDays(list, now).map((d) => (
        <View key={d.key} style={{ gap: space.sm }}>
          {/* R36: day headers, with a Today pill. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.sm }} accessibilityRole="header">
            {d.today ? (
              <View style={{ backgroundColor: colors.brandFill, borderRadius: 12, paddingHorizontal: 10, minHeight: 24, justifyContent: "center" }}>
                <Text style={{ color: colors.brandFg, fontSize: 13, fontWeight: "700", lineHeight: lh(18) }}>{tr("m.cal.today")}</Text>
              </View>
            ) : <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700", lineHeight: lh(20) }}>{d.label}</Text>}
            <Text style={{ color: colors.subtle, fontSize: 13, lineHeight: lh(18) }}>{tr("m.m3x.n_meetings", { count: d.items.length })}</Text>
            <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong }} />
          </View>
          {d.items.map((m) => <MeetingCard key={m.id} m={m} now={now} />)}
        </View>
      )) : (
        <EmptyState icon="video" art="calendar" title={tr("m.m3x.no_meetings")} body={tr("m.m3x.no_meetings_body")} />
      )}
    </ScrollView>
  );
}
