import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Avatar, Badge, Icon } from "@/components/ui";
import { isActive, runA11yLabel, runMeta, runStatus } from "@/lib/runs";
import { useTaskRuns } from "@/lib/run-queries";
import { useNow } from "@/lib/time";
import { shortDate } from "@/lib/format";
import type { AgentRun } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/** R29: the status chip on a run. */
export function RunStatusChip({ status }: { status: string }) {
  const s = runStatus(status);
  return <Badge label={s.label} tone={s.tone} icon={s.icon} />;
}

/** One run in a list: agent, status, the task it worked on, when it started and how long it took. */
export function RunRow({ run, now, showTask = true }: { run: AgentRun; now: number; showTask?: boolean }) {
  const started = run.startedAt ? shortDate(run.startedAt) : null;
  return (
    <Pressable onPress={() => router.push(`/run/${encodeURIComponent(run.id)}`)} accessibilityRole="button"
      accessibilityLabel={runA11yLabel(run, started, now)} accessibilityHint="Opens the run's steps" testID={`run-${run.id}`}
      style={({ pressed }) => ({ backgroundColor: pressed ? colors.elevated : colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.sm, flexDirection: "row", alignItems: "center" })}>
      <Avatar name={run.agent.name} agent size={36} />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <Text style={[font.heading, { fontSize: 16, flexShrink: 1 }]} numberOfLines={1}>{run.agent.name}</Text>
          <RunStatusChip status={run.status} />
        </View>
        {showTask && run.task ? (
          <Text style={{ color: colors.fg, fontSize: 14 }} numberOfLines={1}>
            <Text style={{ color: colors.subtle }}>{run.task.ref}</Text>{`  ${run.task.title}`}
          </Text>
        ) : null}
        <Text style={font.tiny} numberOfLines={1}>{runMeta(run, started, now)}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.subtle} />
    </Pressable>
  );
}

/** R29: a task's agent runs on the task screen (newest 5). Hidden when the task has none. */
export function TaskRuns({ taskId }: { taskId: string }) {
  const q = useTaskRuns(taskId);
  const now = useNow(!!q.data?.some(isActive));
  if (!q.data?.length) return null;
  const shown = q.data.slice(0, 5);
  return (
    <View style={{ gap: space.sm }} testID="task-runs">
      <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }} accessibilityRole="header">Agent runs</Text>
      {shown.map((r) => <RunRow key={r.id} run={r} now={now} showTask={false} />)}
      {q.data.length > shown.length ? <Text style={font.tiny}>{`${q.data.length - shown.length} older ${q.data.length - shown.length === 1 ? "run" : "runs"} under Settings, Agent runs.`}</Text> : null}
    </View>
  );
}
