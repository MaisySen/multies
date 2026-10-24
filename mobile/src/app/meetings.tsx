import { RefreshControl, ScrollView } from "react-native";
import { Banner, Button, EmptyState, Loading } from "@/components/ui";
import { MeetingCard, StartMeetingButton } from "@/components/meetings";
import { useMeetings } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useNow } from "@/lib/time";
import { space } from "@/theme";

/** Upcoming meetings. Video runs on the web meeting page, which Join opens. */
export default function Meetings() {
  const q = useMeetings();
  const offline = useOffline();
  const now = useNow(false);
  if (q.isPending) return <Loading />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load meetings" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const list = [...q.data.meetings].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />}>
      {offline ? <Banner text="You're offline. These are the meetings saved on this phone." /> : null}
      {!q.data.videoEnabled ? <Banner tone="neutral" icon="info" text="Video isn't switched on for this workspace yet. Meetings and guest links still work, and the call starts once it is." /> : null}
      <StartMeetingButton title="Quick meeting" testID="start-meeting-now" />
      {list.length ? list.map((m) => <MeetingCard key={m.id} m={m} now={now} />) : (
        <EmptyState icon="video" title="No meetings coming up" body="Start one here, or from a task or an email." />
      )}
    </ScrollView>
  );
}
