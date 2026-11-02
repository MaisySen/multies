/**
 * M3 (1.10.11): Time on the phone (was a web page). The running timer (stop it here), this week's total and every entry
 * by day. A timer starts from any task.
 */
import { RefreshControl, SectionList, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow } from "@/components/grouped";
import { EmptyState, Loading } from "@/components/ui";
import { ListHeader, Problem, ScreenHeader } from "@/components/m3-ui";
import { TimerChip } from "@/components/timer";
import { useWeekTime } from "@/lib/m3-queries";
import { entriesByDay } from "@/lib/m3";
import { duration, useNow } from "@/lib/time";
import { colors, font, radius, space } from "@/theme";

export default function Time() {
  const insets = useSafeAreaInsets();
  const q = useWeekTime();
  const now = useNow(false);
  const header = <ScreenHeader title="Time" />;
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading time" rows={5} variant="task" /></View>;
  if (q.isError) return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="time-error">{header}<Problem q={q} what="Time entries" testID="time" /></View>;
  const days = entriesByDay(q.data?.entries, now);
  const week = days.reduce((a, d) => a + d.seconds, 0);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="time-screen">{header}
      <SectionList
        sections={days}
        keyExtractor={(e) => e.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}
        ListHeaderComponent={
          <View style={{ gap: space.md, paddingTop: space.md }}>
            <TimerChip />
            <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg }} testID="time-week" accessible accessibilityLabel={`This week, ${duration(week)}`}>
              <Text style={font.tiny}>This week</Text>
              <Text style={[font.title, { color: colors.fg, fontVariant: ["tabular-nums"] }]}>{duration(week)}</Text>
            </View>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="clock" title="No time this week" body="Start a timer from any task. It shows here as it runs." />}
        renderSectionHeader={({ section }) => <ListHeader title={section.title} right={duration(section.seconds)} />}
        renderItem={({ item, index, section }) => (
          <View style={{ backgroundColor: colors.surface, overflow: "hidden",
            borderTopLeftRadius: index === 0 ? radius.lg : 0, borderTopRightRadius: index === 0 ? radius.lg : 0,
            borderBottomLeftRadius: index === section.data.length - 1 ? radius.lg : 0, borderBottomRightRadius: index === section.data.length - 1 ? radius.lg : 0 }}>
            <GroupRow testID={`time-${item.id}`} label={item.task ? item.task.title : item.note || "Time"} sub={[item.task?.ref, item.running ? "Running" : null, item.person.name].filter(Boolean).join(" · ")}
              value={duration(item.seconds)} chevron={!!item.taskId} onPress={item.taskId ? () => router.push({ pathname: "/task/[id]", params: { id: item.taskId! } }) : undefined} />
          </View>
        )}
      />
    </View>
  );
}
