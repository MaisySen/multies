import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Button, EmptyState, Loading, Segmented } from "@/components/ui";
import { useSession } from "@/lib/session";
import { success, warning } from "@/lib/haptics";
import { DEFAULT_EXPIRY, EXPIRY_CHOICES, linkLine, noAccess, type Expiry, type ShareLink } from "@/lib/docs";
import { plainProblem, useShareActions, useShareLinks } from "@/lib/docs-queries";
import { colors, radius, space } from "@/theme";

/**
 * M1: a read only link to a doc (R26), as on the web's Share sheet: anyone with the link reads the doc without signing in,
 * comments stay private. Make a link, copy it (the full link shows once), and turn links off.
 */
export default function DocShare() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useSession();
  const member = !!me?.organization;
  const q = useShareLinks(id, member);
  const { create, revoke } = useShareActions(id ?? "");
  // Round 2 (PR 24): a new link ends after 30 days by default, as on the web; Always stays a choice.
  const [expiry, setExpiry] = useState<Expiry>(DEFAULT_EXPIRY);
  const [showWs, setShowWs] = useState(true);
  const [fresh, setFresh] = useState<ShareLink | null>(null);
  const [copied, setCopied] = useState(false);

  if (!member) return <EmptyState icon="lock" title="No access" body="Share links are for members of a workspace." />;
  if (q.isPending) return <Loading label="Loading share links" rows={3} variant="task" />;
  if (q.error && !q.data) {
    return noAccess(q.error)
      ? <EmptyState icon="lock" title="Can't share this doc" body="It may have been deleted, or you don't have access to it." />
      : <EmptyState icon="alert-circle" title="Couldn't load share links" body={plainProblem(q.error)} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} testID="share-retry" />} />;
  }
  const data = q.data!;
  const make = () => create.mutate({ expiry, showWorkspaceName: showWs }, {
    onSuccess: (r) => { setFresh(r.link); setCopied(false); success(); },
    onError: (e) => { warning(); Alert.alert("Couldn't make a link", plainProblem(e)); },
  });
  const copy = async (url: string) => { await Clipboard.setStringAsync(url); setCopied(true); success(); };
  const turnOff = (l: ShareLink) => Alert.alert("Turn off this link?", "Anyone who has it can no longer open the doc.", [
    { text: "Cancel", style: "cancel" },
    { text: "Turn off", style: "destructive", onPress: () => revoke.mutate(l.id, { onSuccess: () => { if (fresh?.id === l.id) setFresh(null); success(); }, onError: (e) => Alert.alert("Couldn't turn it off", plainProblem(e)) }) },
  ]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xxl * 2 }}>
      <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 21 }}>Anyone with the link can read this doc without signing in. Comments stay private.</Text>
      {!data.allowShareLinks ? (
        <Text style={{ color: colors.fg, fontSize: 16 }} testID="share-off">An admin turned share links off for this workspace.</Text>
      ) : (
        <View style={st.card}>
          <Text style={st.label}>Link works for</Text>
          <Segmented value={expiry} options={EXPIRY_CHOICES} onChange={setExpiry} label="Link works for" />
          <View style={st.switchRow}>
            <Text style={{ color: colors.fg, fontSize: 16, flex: 1 }}>Show workspace name</Text>
            <Switch value={showWs} onValueChange={setShowWs} accessibilityLabel="Show workspace name" testID="share-show-ws" />
          </View>
          <Button label="Create link" icon="link" onPress={make} loading={create.isPending} testID="share-create" />
          {fresh?.url ? (
            <View style={st.fresh} testID="share-fresh">
              <Text style={{ color: colors.subtle, fontSize: 13 }}>Copy it now: the full link is shown only once.</Text>
              <Text style={{ color: colors.fg, fontSize: 14 }} numberOfLines={2} selectable testID="share-url">{fresh.url}</Text>
              <Button label={copied ? "Copied" : "Copy link"} icon={copied ? "check" : "copy"} variant="secondary" onPress={() => copy(fresh.url!)} testID="share-copy" />
            </View>
          ) : null}
        </View>
      )}
      <View style={{ gap: space.sm }}>
        <Text style={st.header} accessibilityRole="header">Active links, {data.links.length}</Text>
        {data.links.length ? (
          <View style={st.group}>
            {data.links.map((l, i) => (
              <View key={l.id} style={[st.linkRow, i > 0 && st.sepTop]} testID={`share-link-${l.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.fg, fontSize: 15 }}>{linkLine(l)}</Text>
                  {l.comments === "on" ? <Text style={{ color: colors.subtle, fontSize: 13 }}>Comments on</Text> : null}
                </View>
                <Pressable onPress={() => turnOff(l)} accessibilityRole="button" accessibilityLabel={`Turn off link. ${linkLine(l)}`} hitSlop={6} style={{ minHeight: 44, justifyContent: "center" }} testID={`share-revoke-${l.id}`}>
                  <Text style={{ color: colors.bad, fontSize: 15, fontWeight: "600" }}>Turn off</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : <Text style={{ color: colors.subtle, fontSize: 15 }}>No active links.</Text>}
        <Text style={{ color: colors.subtle, fontSize: 13 }}>{"A link's full address shows only when it is made. To share it again, make a new link."}</Text>
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: space.lg, gap: space.md },
  label: { color: colors.subtle, fontSize: 13 },
  switchRow: { flexDirection: "row", alignItems: "center", minHeight: 44 },
  fresh: { gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.neutralSoft },
  header: { color: colors.subtle, fontSize: 13, textTransform: "uppercase" },
  group: { backgroundColor: colors.surface, borderRadius: 12, overflow: "hidden" },
  linkRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, minHeight: 56 },
  sepTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.lineStrong },
});
