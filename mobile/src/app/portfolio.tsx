import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { Badge, Banner, Button, EmptyState, Icon, Loading } from "@/components/ui";
import { usePortfolio } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { HEALTH, formatDay, hm, sortPortfolio } from "@/lib/fields";
import type { PortfolioProject } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/** Every project at a glance: health, progress, overdue work, time logged and what is due next. Read only. */
export default function Portfolio() {
  const q = usePortfolio();
  const offline = useOffline();
  if (q.isPending) return <Loading />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load the portfolio" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const list = sortPortfolio(q.data.projects);
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="portfolio">
      {offline ? <Banner text="You're offline. This is the portfolio saved on this phone." /> : null}
      {list.length ? (
        <>
          <Text style={font.small}>{list.length === 1 ? "1 project" : `${list.length} projects`}. Health is set by hand on the web.</Text>
          {list.map((p) => <ProjectRow key={p.id} p={p} />)}
        </>
      ) : (
        <EmptyState icon="layers" title="No projects yet" body="Projects made on the web show up here with their progress." />
      )}
    </ScrollView>
  );
}

function ProjectRow({ p }: { p: PortfolioProject }) {
  const health = HEALTH[p.health ?? "none"];
  const pct = Math.max(0, Math.min(100, Math.round(p.progress)));
  const openNext = p.nextDueTask ? () => router.push({ pathname: "/task/[id]", params: { id: p.nextDueTask!.id } }) : undefined;
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: space.lg, gap: space.md, opacity: p.archived ? 0.7 : 1 }}
      testID={`project-${p.id}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: p.color ?? colors.muted }} />
        <Text style={[font.heading, { fontSize: 17, flex: 1 }]} numberOfLines={1}>{p.name}</Text>
        <Text style={font.tiny}>{p.key}</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Badge label={health.label} tone={health.tone} />
        {p.archived ? <Badge label="Archived" /> : null}
        {p.overdue ? <Badge label={`${p.overdue} overdue`} tone="bad" icon="alert-circle" /> : <Badge label="Nothing overdue" icon="check" />}
      </View>
      {p.healthNote ? <Text style={font.small} numberOfLines={3}>{p.healthNote}</Text> : null}

      <View style={{ gap: 6 }} accessible accessibilityRole="progressbar" accessibilityLabel={`Progress ${pct} percent, ${p.done} of ${p.total} tasks done`}
        accessibilityValue={{ min: 0, max: 100, now: pct }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 14 }}>{pct}%</Text>
          <Text style={font.tiny}>{p.done} of {p.total} done</Text>
        </View>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
          <View style={{ width: `${pct}%`, height: 8, borderRadius: 4, backgroundColor: p.color ?? colors.brand }} />
        </View>
      </View>

      <View style={{ flexDirection: "row", gap: space.md }}>
        <Stat icon="clock" label="Time logged" value={hm(p.timeLoggedSeconds)} />
        <Stat icon="user" label="Owner" value={p.owner?.name ?? "Not set"} />
      </View>
      <Pressable onPress={openNext} disabled={!openNext} accessibilityRole={openNext ? "button" : "text"}
        accessibilityLabel={p.nextDue ? `Next due ${formatDay(p.nextDue)}${p.nextDueTask ? `, ${p.nextDueTask.title}` : ""}` : "Nothing due"}
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name="calendar" size={14} color={colors.subtle} />
        <Text style={[font.small, { flex: 1 }]} numberOfLines={1}>
          {p.nextDue ? <Text style={{ color: colors.fg }}>Next due {formatDay(p.nextDue)}</Text> : "Nothing due"}
          {p.nextDueTask ? `  ${p.nextDueTask.ref} ${p.nextDueTask.title}` : ""}
        </Text>
        {openNext ? <Icon name="chevron-right" size={16} color={colors.subtle} /> : null}
      </Pressable>
    </View>
  );
}

function Stat({ icon, label, value }: { icon: "clock" | "user"; label: string; value: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <Icon name={icon} size={12} color={colors.subtle} />
        <Text style={font.tiny}>{label}</Text>
      </View>
      <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "500" }} numberOfLines={1}>{value}</Text>
    </View>
  );
}
