/**
 * M1 (1.10.9): one newsletter's status and counts, with Pause, Resume and Send test to me where the server allows them.
 */
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Badge, Banner, Button, EmptyState, Loading } from "@/components/ui";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Footnote, LoadError, NoAccess } from "@/components/m1-work";
import { confirmThen, problemText, StatCell, WebNote } from "@/components/m1-more";
import { noAccess, notFoundErr } from "@/lib/contacts-queries";
import { useNewsletter, useNewsletterAction, type NewsletterAction } from "@/lib/m1-more-queries";
import { MERGE_WEB, newsletterActions, pct, shortDate, statusOf } from "@/lib/mail-merge";
import { colors, font, space } from "@/theme";

export default function NewsletterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useNewsletter(id);
  const act = useNewsletterAction(id ?? "");
  const header = <Stack.Screen options={{ title: q.data?.name || "Newsletter" }} />;

  if (noAccess(q.error)) return <>{header}<NoAccess what="Mail merge" /></>;
  if (q.isPending) return <>{header}<Loading label="Loading newsletter" rows={4} /></>;
  if (notFoundErr(q.error)) return <>{header}<EmptyState icon="mail" title="Newsletter not found" body="It may have been deleted." art={null} /></>;
  if (q.error || !q.data) return <>{header}<LoadError title="Couldn't load this newsletter" error={q.error} onRetry={() => q.refetch()} /></>;

  const n = q.data;
  const s = n.stats;
  const can = newsletterActions(n);
  const st = statusOf(n.status);
  const run = (a: NewsletterAction) => act.mutate(a, {
    onSuccess: (r) => { if (a === "test" && r && "to" in r) Alert.alert("Test sent", `A test copy went to ${r.to}.`); },
    onError: (e) => Alert.alert(a === "test" ? "Couldn't send the test" : a === "pause" ? "Couldn't pause" : "Couldn't resume", problemText(e)),
  });

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: space.md, paddingBottom: space.xxl, gap: space.lg }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="newsletter-detail">
      {header}
      <View style={{ paddingHorizontal: space.lg, gap: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Badge label={st.label} tone={st.tone} />
        </View>
        <Text style={font.heading} accessibilityRole="header" testID="newsletter-name">{n.name || "Untitled newsletter"}</Text>
        {n.subject ? <Text style={font.small}>Subject: {n.subject}</Text> : null}
      </View>
      {n.error ? <View style={{ paddingHorizontal: space.lg }}><Banner tone="bad" icon="info" text={n.error} /></View> : null}

      <InsetGroup header="Sending">
        <GroupRow icon="users" tile="teal" label="List" value={n.listName || undefined} />
        {n.scheduledAt ? <GroupRow icon="calendar" tile="orange" label="Scheduled" value={shortDate(n.scheduledAt)} /> : null}
        {n.sentAt ? <GroupRow icon="check" tile="green" label="Finished" value={shortDate(n.sentAt)} /> : null}
      </InsetGroup>

      <InsetGroup header="Counts">
        <View style={{ flexDirection: "row", flexWrap: "wrap" }} testID="newsletter-stats">
          <StatCell value={`${s.sent} of ${s.total}`} label="Sent" testID="stat-sent" />
          <StatCell value={`${pct(s.opened, s.sent)}%`} label={`Opened (${s.opened})`} />
          <StatCell value={`${pct(s.clicked, s.sent)}%`} label={`Clicked (${s.clicked})`} />
          <StatCell value={String(s.unsubscribed)} label="Unsubscribed" />
          <StatCell value={String(s.bounced)} label="Bounced" />
          <StatCell value={String(s.failed + s.skipped)} label="Not sent" />
        </View>
      </InsetGroup>

      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        {can.pause ? <Button label="Pause sending" icon="pause" variant="secondary" loading={act.isPending && act.variables === "pause"}
          onPress={() => confirmThen("Pause this newsletter?", "No more emails go out until you resume it.", "Pause", () => run("pause"))} testID="newsletter-pause" /> : null}
        {can.resume ? <Button label="Resume sending" icon="play" loading={act.isPending && act.variables === "resume"}
          onPress={() => confirmThen("Resume this newsletter?", "Sending carries on with the people who have not had it yet.", "Resume", () => run("resume"))} testID="newsletter-resume" /> : null}
        {can.test ? <Button label="Send test to me" icon="send" variant="secondary" loading={act.isPending && act.variables === "test"}
          onPress={() => confirmThen("Send a test to yourself?", "A copy marked as a test goes to your own address. It counts nothing.", "Send test", () => run("test"))} testID="newsletter-test" /> : null}
        {n.canSend === false && (n.status === "sending" || n.status === "paused") ? (
          <Footnote testID="newsletter-no-send">Only admins can pause or resume a newsletter to a list shared with the whole workspace.</Footnote>
        ) : null}
      </View>
      <WebNote text="Edit, schedule or stop it on the web." path={`${MERGE_WEB}/newsletters/${encodeURIComponent(n.id)}`} />
    </ScrollView>
  );
}
