/**
 * M1 (1.10.9): Mail archive and retention (web Settings > Archive and retention, flag mailArchive). Everyone sees the
 * policy, read only. Owners and admins also see legal holds, saved cases and a read only search of the workspace's mail.
 * Changing the policy, holds and the ZIP export stay on the web.
 */
import { useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack } from "expo-router";
import { Badge, Button, Loading } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Footnote, LoadError, NoAccess, SearchBox } from "@/components/m1-work";
import { FeatureOff, problemText, WebNote } from "@/components/m1-more";
import { noAccess, notFoundErr } from "@/lib/contacts-queries";
import { useArchiveCases, useArchiveHolds, useArchivePolicy, useArchiveSearch } from "@/lib/m1-more-queries";
import { activeHolds, ARCHIVE_WEB, archiveQuery, hitFrom, keepLine, type ArchiveHit } from "@/lib/mail-archive";
import { shortDate } from "@/lib/mail-merge";
import { flagOn, useWebConfig } from "@/lib/web-config";
import { colors, font, space } from "@/theme";

export default function MailArchive() {
  const cfg = useWebConfig();
  const on = cfg.data ? flagOn(cfg.data, "mailArchive") : true;
  const policy = useArchivePolicy();
  const p = policy.data?.policy;
  const admin = p?.canManage === true;
  const holds = useArchiveHolds(on && admin);
  const cases = useArchiveCases(on && admin);
  const search = useArchiveSearch();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ArchiveHit[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const header = <Stack.Screen options={{ title: "Mail archive" }} />;

  if (!on || notFoundErr(policy.error)) return <>{header}<FeatureOff title="Mail archive is off" body="Archive and retention is not switched on for this workspace." /></>;
  if (noAccess(policy.error)) return <>{header}<NoAccess what="Mail archive" /></>;
  if (policy.isPending) return <>{header}<Loading label="Loading mail archive" rows={4} /></>;
  if (policy.error || !p) return <>{header}<LoadError title="Couldn't load the archive policy" error={policy.error} onRetry={() => policy.refetch()} /></>;

  const runSearch = (more = false) => {
    const words = archiveQuery(q);
    search.mutate({ q: words, ...(more && next ? { cursor: next } : {}) }, {
      onSuccess: (r) => { setHits((prev) => (more && prev ? [...prev, ...r.hits] : r.hits)); setNext(r.next); },
      onError: (e) => Alert.alert("Couldn't search", problemText(e)),
    });
  };
  const live = holds.data ? activeHolds(holds.data.holds) : [];

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl, gap: space.lg }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={policy.isRefetching} onRefresh={() => { policy.refetch(); if (admin) { holds.refetch(); cases.refetch(); } }} />} testID="mail-archive">
      {header}
      <InsetGroup header="Retention" testID="archive-policy">
        <GroupRow icon="archive" tile="indigo" label="Mail is kept" sub={keepLine(p)} testID="archive-keep" />
        {p.enabled && p.startsAt ? <GroupRow icon="calendar" tile="orange" label="Deleting started" value={shortDate(p.startsAt)} /> : null}
        {p.lastRunAt ? <GroupRow icon="clock" tile="gray" label="Last clean up" value={shortDate(p.lastRunAt)} sub={`${p.lastRunDeleted} deleted`} /> : null}
        <GroupRow icon="trash" tile="red" label="Deleted by the policy so far" value={String(p.totalDeleted)} />
        <GroupRow icon="globe" tile="gray" label="Time zone" value={p.timeZone} />
        {admin && typeof p.activeHolds === "number" ? <GroupRow icon="lock" tile="purple" label="Active legal holds" value={String(p.activeHolds)} /> : null}
      </InsetGroup>

      {!admin ? (
        <View style={{ paddingHorizontal: space.lg }}><Footnote testID="archive-member-note">Only workspace owners and admins can change the policy or search the archive.</Footnote></View>
      ) : (
        <>
          <InsetGroup header="Legal holds" footer="Mail under a hold is never deleted by the policy." testID="archive-holds">
            {holds.isPending ? <GroupRow icon="lock" label="Loading holds" /> : holds.error ? (
              <GroupRow icon="info" tile="red" label="Couldn't load holds" sub={problemText(holds.error)} onPress={() => holds.refetch()} />
            ) : live.length ? live.map((h) => (
              <GroupRow key={h.id} icon={h.kind === "mailbox" ? "inbox" : "user"} tile="purple" label={h.name || h.targetLabel}
                sub={`${h.targetLabel}, since ${shortDate(h.createdAt)}`} testID={`hold-${h.id}`} />
            )) : <GroupRow icon="lock" tile="gray" label="No active holds" />}
          </InsetGroup>

          <View style={{ gap: space.sm }}>
            <Text style={[font.headline, { paddingHorizontal: space.lg }]} accessibilityRole="header">Search the archive</Text>
            <View style={{ paddingHorizontal: space.lg }}>
              <SearchBox value={q} onChange={setQ} label="Search archived mail" placeholder="Words, people or subjects" testID="archive-search" />
            </View>
            <View style={{ paddingHorizontal: space.lg }}>
              <Button label="Search" icon="search" onPress={() => runSearch(false)} loading={search.isPending && !next} testID="archive-search-go" />
            </View>
            {hits ? (
              <InsetGroup footer="Read only. Every search is written to the audit log." testID="archive-hits">
                {hits.length ? hits.map((h) => (
                  <GroupRow key={h.id} icon="mail" label={h.subject || "(no subject)"} sub={`${hitFrom(h)}\n${h.mailbox}, ${shortDate(h.date)}`}
                    right={h.held ? <Badge label="On hold" tone="warn" /> : undefined} testID={`hit-${h.id}`} />
                )) : <GroupRow icon="search" tile="gray" label="No mail matches" testID="archive-no-hits" />}
              </InsetGroup>
            ) : null}
            {hits && next ? <View style={{ paddingHorizontal: space.lg }}><Button label="Show more" variant="secondary" onPress={() => runSearch(true)} loading={search.isPending} testID="archive-more" /></View> : null}
          </View>

          <InsetGroup header="Saved cases" testID="archive-cases">
            {cases.isPending ? <GroupRow icon="archive" label="Loading cases" /> : cases.error ? (
              <GroupRow icon="info" tile="red" label="Couldn't load cases" sub={problemText(cases.error)} onPress={() => cases.refetch()} />
            ) : cases.data?.cases.length ? cases.data.cases.map((c) => (
              <GroupRow key={c.id} icon="archive" tile="blue" label={c.name}
                sub={c.lastExportedAt ? `Exported ${c.exportCount} times, last ${shortDate(c.lastExportedAt)}` : `Made ${shortDate(c.createdAt)}, not exported yet`} testID={`case-${c.id}`} />
            )) : <GroupRow icon="archive" tile="gray" label="No saved cases" />}
          </InsetGroup>
        </>
      )}
      <WebNote text={admin ? "Changing the policy, placing holds and the ZIP export are on the web." : "The full policy is on the web."} path={ARCHIVE_WEB} testID="archive-web" />
    </ScrollView>
  );
}
