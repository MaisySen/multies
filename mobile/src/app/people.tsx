import { Children } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { g } from "@/components/grouped";
import { Avatar, Badge, Banner, Button, EmptyState, Loading } from "@/components/ui";
import { usePeople } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import type { Person } from "@/api/types";
import { colors, font, space } from "@/theme";

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Who is in the workspace: people with their role, and AI agents with a badge, title and bio. Read only. */
export default function People() {
  const q = usePeople();
  const offline = useOffline();
  if (q.isPending) return <Loading />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load people" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const humans = q.data.filter((p) => p.kind === "human");
  const agents = q.data.filter((p) => p.kind === "agent");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl * 2 }} style={{ backgroundColor: colors.bg }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="people">
      {offline ? <Banner text="You're offline. This is the list saved on this phone." /> : null}
      <Text style={font.small}>{count(humans.length, "person", "people")} and {count(agents.length, "AI agent", "AI agents")}. Titles and bios are edited on the web.</Text>
      {humans.length ? <Section title="People">{humans.map((p) => <PersonRow key={p.id} p={p} />)}</Section> : null}
      {agents.length ? <Section title="AI agents">{agents.map((p) => <PersonRow key={p.id} p={p} />)}</Section> : (
        <EmptyState icon="bot" title="No AI agents yet" body="Add an AI agent member on the web, under Settings, Team. It gets its own key and takes no seat." />
      )}
    </ScrollView>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 7, marginTop: space.sm }}>
      <Text style={[g.header, { marginHorizontal: space.lg }]} accessibilityRole="header">{title}</Text>
      {/* R36: one inset group with hairline separators, not a stack of cards. */}
      <View style={[g.group, { marginHorizontal: 0 }]}>
        {Children.toArray(children).map((c, i) => (
          <View key={i}>{i ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.lineStrong, marginLeft: 72 }} /> : null}{c}</View>
        ))}
      </View>
    </View>
  );
}

function PersonRow({ p }: { p: Person }) {
  const agent = p.kind === "agent";
  const sub = agent ? (p.type === "mail_agent" ? p.inbox : null) : p.email;
  return (
    <View style={{ backgroundColor: colors.surface, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md, flexDirection: "row" }}
      testID={`person-${p.id}`} accessible accessibilityLabel={[p.name, agent ? "AI agent" : null, p.title, p.bio].filter(Boolean).join(", ")}>
      <Avatar name={p.name} agent={agent} size={40} />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <Text style={[font.headline]} numberOfLines={1}>{p.name}</Text>
          {agent ? <Badge label="AI agent" tone="brand" icon="bot" /> : p.role ? <Badge label={ROLE[p.role] ?? p.role} /> : null}
        </View>
        {p.title ? <Text style={{ color: colors.fg, fontSize: 14 }} numberOfLines={1}>{p.title}</Text> : null}
        {sub ? <Text style={font.tiny} numberOfLines={1}>{sub}</Text> : null}
        {p.bio ? <Text style={font.small} numberOfLines={4}>{p.bio}</Text> : null}
      </View>
    </View>
  );
}
