/**
 * M3 (1.10.11): Goals on the phone (was a web page). Every goal with its progress, health, owner, due date and key
 * results, children under their parent. Pull to refresh. Editing goals stays on the web for now.
 */
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, EmptyState, Loading } from "@/components/ui";
import { ListHeader, Problem, ProgressBar, ScreenHeader } from "@/components/m3-ui";
import { useGoals } from "@/lib/m3-queries";
import { flattenGoals, HEALTH, krLine, pct } from "@/lib/m3";
import { shortDate } from "@/lib/format";
import { colors, font, radius, space } from "@/theme";

export default function Goals() {
  const insets = useSafeAreaInsets();
  const q = useGoals();
  const header = <ScreenHeader title="Goals" />;
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading goals" rows={5} variant="task" /></View>;
  if (q.isError) return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="goals-error">{header}<Problem q={q} what="Goals" testID="goals" /></View>;
  const rows = flattenGoals(q.data?.goals);
  if (!rows.length) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="goals-empty">{header}
      <EmptyState icon="flag" title="No goals yet" body="Goals your team sets show here with their progress." /></View>;
  }
  const overall = q.data?.summary?.progress ?? Math.round(rows.filter((r) => r.depth === 0).reduce((a, r) => a + pct(r.goal.progress), 0) / Math.max(1, rows.filter((r) => r.depth === 0).length));
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="goals-screen">{header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl, gap: space.md }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}>
        <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm, marginTop: space.md }} testID="goals-summary">
          <Text style={font.tiny}>All goals</Text>
          <Text style={[font.title, { color: colors.fg }]}>{pct(overall)}%</Text>
          <ProgressBar value={overall} label={`All goals, ${pct(overall)} percent`} />
        </View>
        <ListHeader title="Goals" right={`${rows.length}`} />
        {rows.map(({ goal: g, parent }) => {
          const h = g.health ? HEALTH[g.health] : null;
          const meta = [g.owner?.name, g.due ? `Due ${shortDate(g.due)}` : null].filter(Boolean).join(" · ");
          return (
            <View key={g.id} testID={`goal-${g.id}`} style={{ backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm }}>
              {parent ? <Text style={font.tiny} numberOfLines={1}>Part of {parent}</Text> : null}
              <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
                <Text style={[font.headline, { flex: 1 }]} accessibilityRole="header">{g.name}</Text>
                <Text style={[font.headline, { color: colors.fg, fontVariant: ["tabular-nums"] }]}>{pct(g.progress)}%</Text>
              </View>
              <ProgressBar value={g.progress} tone={h?.tone ?? "brand"} label={`${g.name}, ${pct(g.progress)} percent`} />
              {meta || h ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
                  {h ? <Badge label={h.label} tone={h.tone} /> : null}
                  {meta ? <Text style={font.small} numberOfLines={1}>{meta}</Text> : null}
                </View>
              ) : null}
              {g.keyResults.map((k) => (
                <View key={k.id} style={{ gap: 6, paddingTop: space.xs }} testID={`kr-${k.id}`}>
                  <View style={{ flexDirection: "row", gap: space.sm }}>
                    <Text style={[font.small, { flex: 1, color: colors.fg }]} numberOfLines={2}>{k.name}</Text>
                    <Text style={[font.small, { fontVariant: ["tabular-nums"] }]}>{krLine(k)}</Text>
                  </View>
                  <ProgressBar value={k.progress} label={`${k.name}, ${pct(k.progress)} percent`} />
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
