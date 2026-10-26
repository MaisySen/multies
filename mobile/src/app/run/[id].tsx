import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Avatar, Banner, Button, Card, EmptyState, Icon, Loading, Row } from "@/components/ui";
import { RunStatusChip } from "@/components/runs";
import { useRun } from "@/lib/run-queries";
import { useCancelRun } from "@/lib/triage-queries";
import { command, createHandlers } from "@/lib/commands";
import { success } from "@/lib/haptics";
import { useOffline } from "@/lib/offline";
import { useNow } from "@/lib/time";
import { durationLabel, isActive, stepKind } from "@/lib/runs";
import { longDate, shortDate } from "@/lib/format";
import { ApiError } from "@/api/errors";
import type { RunStep } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/** R29: one agent run: who ran it, on which task, each step in order, and the result. R31: cancel while it runs. */
export default function RunDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useRun(id);
  const offline = useOffline();
  const now = useNow(!!q.data && isActive(q.data));
  // R31: cancel a queued or running run, after a confirm. The title comes from the command registry.
  const cancel = useCancelRun();
  const cancelTitle = command("run-cancel").title;
  const handlers = createHandlers({
    navigate: (href) => router.push(href as never), openWeb: () => {},
    cancelRun: (runId) => Alert.alert("Cancel this run?", "The agent stops at its next step. What it already did stays.", [
      { text: "Keep running", style: "cancel" },
      { text: cancelTitle, style: "destructive", onPress: () => cancel.mutate(runId, {
        onSuccess: () => success(),
        onError: (e) => Alert.alert(e instanceof ApiError && e.status === 409 ? "This run has already finished" : "Couldn't cancel the run", e instanceof ApiError && e.status === 409 ? undefined : e.message),
      }) },
    ]),
  });

  if (q.isPending) return <Loading label="Loading run" rows={4} />;
  if (q.error) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return gone
      ? <EmptyState icon="cpu" title="Run not found" body="It may have been on a task that was deleted." />
      : <EmptyState icon="alert-circle" title="Couldn't load this run" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  }
  const r = q.data;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="run-detail">
      <Stack.Screen options={{ title: "Run" }} />
      {offline ? <Banner text="You're offline. This is the copy saved on this phone." /> : null}
      <Card style={{ gap: space.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Avatar name={r.agent.name} agent size={44} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={[font.heading, { fontSize: 18 }]} numberOfLines={1}>{r.agent.name}</Text>
            <View style={{ flexDirection: "row" }}><RunStatusChip status={r.status} /></View>
          </View>
        </View>
        <Facts label="Started" value={r.startedAt ? longDate(r.startedAt) : "Not started yet"} />
        {r.finishedAt ? <Facts label="Finished" value={longDate(r.finishedAt)} /> : null}
        <Facts label="Duration" value={durationLabel(r, now)} />
        {isActive(r) && !offline ? (
          <Button label={cancelTitle} variant="danger" icon="circle-stop" loading={cancel.isPending} onPress={() => handlers["run-cancel"]({ runId: r.id })} testID="run-cancel" />
        ) : null}
      </Card>

      {r.task ? (
        <View style={{ borderRadius: radius.lg, overflow: "hidden", borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
          <Row icon="check-square" label={`${r.task.ref}  ${r.task.title}`} onPress={() => router.push(`/task/${encodeURIComponent(r.taskId)}`)} testID="run-task" />
        </View>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Heading>{`Steps (${r.steps.length})`}</Heading>
        {r.steps.length ? (
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, paddingVertical: space.sm }} testID="run-steps">
            {r.steps.map((s, n) => <Step key={`${s.at}-${n}`} s={s} n={n} last={n === r.steps.length - 1} />)}
          </View>
        ) : (
          <Text style={font.small}>{isActive(r) ? "No steps yet. They show here as the agent works." : "This run logged no steps."}</Text>
        )}
      </View>

      <View style={{ gap: space.sm }}>
        <Heading>Result</Heading>
        <Card>
          <Text style={{ color: r.result ? colors.fg : colors.subtle, fontSize: 15, lineHeight: 21 }} selectable testID="run-result">
            {r.result || (isActive(r) ? "The agent hasn't finished yet." : "No result was recorded.")}
          </Text>
        </Card>
      </View>
    </ScrollView>
  );
}

function Heading({ children }: { children: string }) {
  return <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }} accessibilityRole="header">{children}</Text>;
}

function Facts({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.md }} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text style={font.small}>{label}</Text>
      <Text style={{ color: colors.fg, fontSize: 14, flexShrink: 1, textAlign: "right" }}>{value}</Text>
    </View>
  );
}

function Step({ s, n, last }: { s: RunStep; n: number; last: boolean }) {
  const k = stepKind(s.kind);
  const at = shortDate(s.at);
  return (
    <View style={{ flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm }} accessible
      accessibilityLabel={`Step ${n + 1}, ${k.label}, ${at}: ${s.text}`} testID={`run-step-${n}`}>
      <View style={{ alignItems: "center", width: 28 }}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
          <Icon name={k.icon} size={14} color={colors.brand} />
        </View>
        {!last ? <View style={{ width: 2, flex: 1, minHeight: 8, backgroundColor: colors.line, marginTop: 4 }} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2, paddingBottom: last ? 0 : space.sm }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space.sm }}>
          <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600" }}>{k.label}</Text>
          <Text style={font.tiny}>{at}</Text>
        </View>
        <Text style={{ color: colors.fg, fontSize: 15, lineHeight: 21 }} selectable>{s.text}</Text>
      </View>
    </View>
  );
}
