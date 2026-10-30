import { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Banner, Button, Chip, EmptyState, Loading } from "@/components/ui";
import { RunRow } from "@/components/runs";
import { listNotOnServer, useRuns } from "@/lib/run-queries";
import { useOffline } from "@/lib/offline";
import { useNow } from "@/lib/time";
import { isActive } from "@/lib/runs";
import { font, space } from "@/theme";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "queued", label: "Queued" },
  { id: "failed", label: "Failed" },
  { id: "succeeded", label: "Succeeded" },
  { id: "cancelled", label: "Cancelled" },
] as const;
type Filter = (typeof FILTERS)[number]["id"];

/** R29: the workspace's agent runs, newest first. Read only; open one for its steps. */
export default function Runs() {
  const [filter, setFilter] = useState<Filter>("all");
  const q = useRuns(filter === "all" ? undefined : filter);
  const offline = useOffline();
  const now = useNow(!!q.data?.some(isActive));

  const chips = (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: 2 }} accessibilityLabel="Filter runs by status">
      {FILTERS.map((f) => <Chip key={f.id} label={f.label} selected={filter === f.id} onPress={() => setFilter(f.id)} />)}
    </ScrollView>
  );

  let body: React.ReactNode;
  if (q.isPending) body = <Loading label="Loading runs" rows={5} />;
  else if (q.error && listNotOnServer(q.error)) {
    body = <EmptyState icon="cpu" title="Runs list coming soon" body="This list arrives with the next Multies server update. Until then, open a task to see its agent runs." />;
  } else if (q.error) {
    body = <EmptyState icon="alert-circle" title="Couldn't load runs" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  } else if (!q.data.length) {
    body = filter === "all"
      ? <EmptyState icon="bot" title="No agent runs yet" body="When an AI agent member works on a task, its run shows here with each step it took." />
      : <EmptyState icon="bot" title={`No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} runs`} body="Try another filter." />;
  } else {
    body = (
      <View style={{ gap: space.sm }}>
        {q.data.map((r) => <RunRow key={r.id} run={r} now={now} />)}
        <Text style={[font.tiny, { textAlign: "center", marginTop: space.sm }]}>{q.data.length === 50 ? "The 50 newest runs." : `${q.data.length} ${q.data.length === 1 ? "run" : "runs"}.`} Runs are started by agents and on the web.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="runs">
      {offline ? <Banner text="You're offline. These are the runs saved on this phone." /> : null}
      {chips}
      {body}
    </ScrollView>
  );
}
