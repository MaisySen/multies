import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { meetingDays } from "@/lib/meetings";
import { Banner, Button, EmptyState, Loading } from "@/components/ui";
import { MeetingCard, StartMeetingButton } from "@/components/meetings";
import { useMeetings } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useNow } from "@/lib/time";
import { colors, space } from "@/theme";

/** Upcoming meetings. Video runs on the web meeting page, which Join opens. */
export default function Meetings() {
  const q = useMeetings();
  const offline = useOffline();
  const now = useNow(false);
  if (q.isPending) return <Loading />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load meetings" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const list = [...q.data.meetings].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />}>
      {offline ? <Banner text="You're offline. These are the meetings saved on this phone." /> : null}
      {!q.data.videoEnabled ? <Banner tone="neutral" icon="info" text="Video isn't switched on for this workspace yet. Meetings and guest links still work, and the call starts once it is." /> : null}
      <StartMeetingButton title="Quick meeting" testID="start-meeting-now" />
      {list.length ? meetingDays(list, now).map((d) => (
        <View key={d.key} style={{ gap: space.sm }}>
          {/* R36: day headers, with a Today pill. */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.sm }} accessibilityRole="header">
            {d.today ? (
              <View style={{ backgroundColor: colors.brandFill, borderRadius: 11, paddingHorizontal: 10, height: 22, justifyContent: "center" }}>
                <Text style={{ color: colors.brandFg, fontSize: 13, fontWeight: "700" }}>Today</Text>
              </View>
            ) : <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>{d.label}</Text>}
            <Text style={{ color: colors.subtle, fontSize: 13 }}>{d.items.length === 1 ? "1 meeting" : `${d.items.length} meetings`}</Text>
            <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong }} />
          </View>
          {d.items.map((m) => <MeetingCard key={m.id} m={m} now={now} />)}
        </View>
      )) : (
        <EmptyState icon="video" art="calendar" title="No meetings coming up" body="Start one here, or from a task or an email." />
      )}
    </ScrollView>
  );
}
