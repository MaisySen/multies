import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Button, Field, Icon } from "@/components/ui";
import { useRunningTimer, useTimerMutations } from "@/lib/queries";
import { clock, duration, elapsed, parseMinutes, useNow } from "@/lib/time";
import type { Task, TaskView } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/** The running timer, wherever it is: tap to open its task, or stop it. Renders nothing when no timer runs. */
export function TimerChip() {
  const run = useRunningTimer().data;
  const { stop } = useTimerMutations();
  const now = useNow(!!run);
  if (!run) return null;
  const label = run.task ? `${run.task.ref} ${run.task.title}` : "Timer";
  return (
    <View testID="timer-chip" style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.brandSoft, borderColor: colors.brand, borderWidth: 1, borderRadius: radius.md, paddingLeft: space.md }}>
      <Pressable style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 }} accessibilityRole="button"
        accessibilityLabel={`Timer running on ${label}, ${clock(elapsed(run, now))}. Open the task`}
        onPress={() => run.taskId && router.push({ pathname: "/task/[id]", params: { id: run.taskId } })}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand }} />
        <Text style={{ color: colors.fg, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{clock(elapsed(run, now))}</Text>
        <Text style={{ color: colors.fg, flex: 1 }} numberOfLines={1}>{label}</Text>
      </Pressable>
      <Pressable onPress={() => stop.mutate(undefined, { onError: (e) => Alert.alert("The timer didn't stop", e.message) })} disabled={stop.isPending}
        accessibilityRole="button" accessibilityLabel="Stop the timer" testID="timer-chip-stop"
        style={{ minHeight: 44, minWidth: 64, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 4, paddingHorizontal: space.md }}>
        <Icon name="square" size={14} color={colors.brand} />
        <Text style={{ color: colors.brand, fontWeight: "700" }}>Stop</Text>
      </Pressable>
    </View>
  );
}

/** Start or stop a timer on this task, its total time, and a small form to log time by hand. */
export function TaskTime({ task, detail }: { task: Task; detail: TaskView }) {
  const run = useRunningTimer().data;
  const m = useTimerMutations();
  const mine = run && run.taskId === task.id ? run : null;
  const now = useNow(!!mine);
  const [logging, setLogging] = useState(false);
  const [minutes, setMinutes] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // The total from the server counts a running timer up to when it was fetched; count it live here.
  const stopped = (detail.time?.entries ?? []).filter((e) => !e.running).reduce((n, e) => n + e.seconds, 0);
  const total = detail.time ? stopped + (mine ? elapsed(mine, now) : 0) : null;

  const start = () => m.start.mutate({ taskId: task.id }, { onError: (e) => Alert.alert("The timer didn't start", e.message) });
  const stop = () => m.stop.mutate(undefined, { onError: (e) => Alert.alert("The timer didn't stop", e.message) });
  const save = () => {
    const mins = parseMinutes(minutes);
    if (mins === null) { setErr("Enter minutes, like 30, or hours and minutes, like 1:15."); return; }
    setErr(null);
    m.log.mutate({ taskId: task.id, minutes: mins, note: note.trim() || undefined }, {
      onSuccess: () => { setMinutes(""); setNote(""); setLogging(false); },
      onError: (e) => Alert.alert("Time not logged", e.message),
    });
  };

  return (
    <View style={{ gap: space.sm, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: mine ? colors.brand : colors.line, padding: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 }} accessibilityRole="header">Time</Text>
          {mine ? (
            <Text testID="timer-elapsed" accessibilityLabel={`Timer running, ${clock(elapsed(mine, now))}`}
              style={{ color: colors.fg, fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{clock(elapsed(mine, now))}</Text>
          ) : null}
          <Text style={font.small} testID="time-total">{total === null ? "Total not loaded yet" : `Total ${duration(total)}`}</Text>
        </View>
        {mine ? (
          <Button label="Stop" icon="square" variant="danger" onPress={stop} loading={m.stop.isPending} testID="timer-stop" />
        ) : (
          <Button label="Start timer" icon="play" onPress={start} loading={m.start.isPending} testID="timer-start"
            accessibilityHint={run ? "Stops the timer running on your other task first" : undefined} />
        )}
      </View>
      {run && !mine ? <Text style={font.tiny}>Starting here stops your timer on {run.task?.ref ?? "another task"}.</Text> : null}
      {logging ? (
        <View style={{ gap: space.sm }}>
          <Field label="Minutes" value={minutes} onChangeText={setMinutes} keyboardType="numbers-and-punctuation" placeholder="30 or 1:15" error={err} testID="log-minutes" />
          <Field label="Note (optional)" value={note} onChangeText={setNote} testID="log-note" />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button label="Save time" icon="check" variant="secondary" onPress={save} loading={m.log.isPending} testID="log-save" style={{ flex: 1 }} />
            <Button label="Cancel" variant="ghost" onPress={() => { setLogging(false); setErr(null); }} />
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setLogging(true)} accessibilityRole="button" accessibilityLabel="Log time by hand" testID="log-time"
          style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36 }}>
          <Icon name="plus" size={16} color={colors.brand} />
          <Text style={{ color: colors.brand, fontWeight: "600" }}>Log time</Text>
        </Pressable>
      )}
      {detail.time?.entries.filter((e) => !e.running).slice(0, 3).map((e) => (
        <View key={e.id} style={{ flexDirection: "row", gap: space.sm }}>
          <Text style={[font.tiny, { width: 56 }]}>{duration(e.seconds)}</Text>
          <Text style={[font.tiny, { flex: 1 }]} numberOfLines={1}>
            {e.person.name}, {new Date(e.startedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}{e.note ? `: ${e.note}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}
