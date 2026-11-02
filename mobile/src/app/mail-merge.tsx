/**
 * M1 (1.10.9): Mail merge status (web Tools > Mail merge, flag merge_plus_r109): newsletters with status and counts,
 * lists with member counts, journeys on or paused. Writing, lists and scheduling stay on the web.
 */
import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { router, Stack } from "expo-router";
import { Badge, EmptyState, Loading, Segmented } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { LoadError, NoAccess } from "@/components/m1-work";
import { FeatureOff, WebNote } from "@/components/m1-more";
import { noAccess, notFoundErr } from "@/lib/contacts-queries";
import { useJourneys, useMergeLists, useNewsletters } from "@/lib/m1-more-queries";
import { journeyStatusOf, listLine, MERGE_FEATURE, MERGE_WEB, newsletterLine, statusOf } from "@/lib/mail-merge";
import { toolFeatureOn, useWebConfig } from "@/lib/web-config";
import { colors, space } from "@/theme";

type Tab = "newsletters" | "lists" | "journeys";

export default function MailMerge() {
  const [tab, setTab] = useState<Tab>("newsletters");
  const cfg = useWebConfig();
  const on = cfg.data ? toolFeatureOn(cfg.data, MERGE_FEATURE) : true;
  const news = useNewsletters(on && tab === "newsletters");
  const lists = useMergeLists(on && tab === "lists");
  const journeys = useJourneys(on && tab === "journeys");
  const q = tab === "newsletters" ? news : tab === "lists" ? lists : journeys;
  const header = <Stack.Screen options={{ title: "Mail merge" }} />;

  if (!on || notFoundErr(q.error)) return <>{header}<FeatureOff title="Mail merge is off" body="Newsletters and journeys are not switched on for this workspace." /></>;

  let body;
  if (noAccess(q.error)) body = <NoAccess what="Mail merge" />;
  else if (q.isPending) body = <Loading label="Loading mail merge" rows={4} />;
  else if (q.error) body = <LoadError title="Couldn't load mail merge" error={q.error} onRetry={() => q.refetch()} />;
  else if (tab === "newsletters") {
    const rows = news.data?.newsletters ?? [];
    body = rows.length ? (
      <InsetGroup testID="merge-newsletters">
        {rows.map((n) => (
          <GroupRow key={n.id} icon="mail" tile="blue" label={n.name || "Untitled newsletter"} sub={newsletterLine(n)}
            right={<Badge label={statusOf(n.status).label} tone={statusOf(n.status).tone} />}
            onPress={() => router.push({ pathname: "/newsletter/[id]", params: { id: n.id } })} chevron testID={`newsletter-${n.id}`} />
        ))}
      </InsetGroup>
    ) : <EmptyState icon="mail" title="No newsletters yet" body="Write one on the web. Its sending shows here." art={null} />;
  } else if (tab === "lists") {
    const rows = lists.data?.lists ?? [];
    body = rows.length ? (
      <InsetGroup testID="merge-lists">
        {rows.map((l) => (
          <GroupRow key={l.id} icon="users" tile="teal" label={l.name} sub={listLine(l)} value={l.visibility === "private" ? "Private" : "Workspace"} testID={`list-${l.id}`} />
        ))}
      </InsetGroup>
    ) : <EmptyState icon="users" title="No lists yet" body="Make a list on the web from your contacts." art={null} />;
  } else {
    const rows = journeys.data?.journeys ?? [];
    body = rows.length ? (
      <InsetGroup testID="merge-journeys">
        {rows.map((j) => (
          <GroupRow key={j.id} icon="send" tile="purple" label={j.name} sub={`${j.listName ? `${j.listName}, ` : ""}${j.enrolled} enrolled`}
            right={<Badge label={journeyStatusOf(j.status).label} tone={journeyStatusOf(j.status).tone} />}
            onPress={() => router.push({ pathname: "/journey/[id]", params: { id: j.id } })} chevron testID={`journey-${j.id}`} />
        ))}
      </InsetGroup>
    ) : <EmptyState icon="send" title="No journeys yet" body="Set up a welcome series on the web." art={null} />;
  }

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl, gap: space.lg }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="mail-merge">
      {header}
      <View style={{ paddingHorizontal: space.lg }}>
        <Segmented<Tab> label="Show" value={tab} onChange={setTab}
          options={[{ id: "newsletters", label: "Newsletters" }, { id: "lists", label: "Lists" }, { id: "journeys", label: "Journeys" }]} />
      </View>
      {body}
      <WebNote text="Write, schedule and edit lists on the web." path={MERGE_WEB} testID="merge-web" />
    </ScrollView>
  );
}
