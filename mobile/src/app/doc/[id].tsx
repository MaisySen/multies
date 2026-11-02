import { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button, EmptyState, Icon, Skeleton } from "@/components/ui";
import { DocBlocks } from "@/components/doc-reader";
import { API_BASE } from "@/config";
import { useSession } from "@/lib/session";
import { useWebConfig } from "@/lib/web-config";
import { docBlocks, docWebPath, noAccess, untitled } from "@/lib/docs";
import { imageHeaders, openWebPath, plainProblem, useDoc, useDocComments } from "@/lib/docs-queries";
import { colors, space } from "@/theme";

/**
 * M1: one doc, read only and drawn natively from the editor's stored JSON. Comments (when Docs plus is on for this
 * workspace), a read only share link, and Open on the web for editing.
 */
export default function DocReader() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { transport, me } = useSession();
  const member = !!me?.organization;
  const doc = useDoc(member ? id : undefined);
  const cfg = useWebConfig();
  const docsPlus = !!cfg.data?.docsPlus;
  const comments = useDocComments(id, member && docsPlus);
  const headers = useMemo(() => imageHeaders(transport), [transport]);
  const blocks = useMemo(() => docBlocks(doc.data?.content), [doc.data?.content]);
  const [pulling, setPulling] = useState(false);
  const openWeb = () => openWebPath(docWebPath(id ?? ""));

  if (!member) return <EmptyState icon="lock" title="No access to this doc" body="Docs are for members of a workspace." />;
  if (doc.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.lg, gap: space.md }} accessible accessibilityLabel="Loading doc" testID="doc-loading">
        <Skeleton width="70%" height={26} /><Skeleton width="40%" /><Skeleton width="100%" height={80} /><Skeleton width="90%" />
      </View>
    );
  }
  if (doc.error && !doc.data) {
    return noAccess(doc.error)
      ? <EmptyState icon="lock" title="Can't open this doc" body="It may have been deleted, or you don't have access to it." />
      : <EmptyState icon="alert-circle" title="Couldn't open this doc" body={plainProblem(doc.error)} action={<Button label="Try again" variant="secondary" onPress={() => doc.refetch()} testID="doc-retry" />} />;
  }
  const d = doc.data!;
  const count = comments.data ? comments.data.team.length + comments.data.public.length : 0;
  const updated = new Date(d.updatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  const refresh = async () => { setPulling(true); try { await Promise.all([doc.refetch(), docsPlus ? comments.refetch() : null]); } finally { setPulling(false); } };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: "" }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: space.xxl * 2, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.subtle} />} testID="doc-reader">
        <View style={{ gap: space.xs }}>
          <Text style={st.title} accessibilityRole="header" selectable>{untitled(d.title)}</Text>
          <Text style={{ color: colors.subtle, fontSize: 14 }}>Updated {updated}. Read only on the phone.</Text>
        </View>
        <View style={st.actions}>
          {docsPlus ? <Action icon="message-square" label={count ? `Comments ${count}` : "Comments"} a11y={`Comments, ${count}`} onPress={() => router.push({ pathname: "/doc/comments/[id]", params: { id: d.id } })} testID="doc-comments" /> : null}
          <Action icon="link" label="Share" a11y="Share a read only link" onPress={() => router.push({ pathname: "/doc/share/[id]", params: { id: d.id } })} testID="doc-share" />
          <Action icon="external-link" label="Edit on the web" a11y="Open on the web to edit" onPress={openWeb} testID="doc-web" />
        </View>
        {blocks.length
          ? <DocBlocks blocks={blocks} base={API_BASE} headers={headers} onOpenWeb={openWeb} />
          : <Text style={{ color: colors.subtle, fontSize: 17 }}>This page is empty.</Text>}
      </ScrollView>
    </View>
  );
}

function Action({ icon, label, a11y, onPress, testID }: { icon: "message-square" | "link" | "external-link"; label: string; a11y: string; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y} testID={testID}
      style={({ pressed }) => [st.action, pressed && { backgroundColor: colors.hover }]}>
      <Icon name={icon} size={17} color={colors.brand} />
      <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  title: { color: colors.fg, fontSize: 28, fontWeight: "700", lineHeight: 34 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  action: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, paddingHorizontal: space.md, borderRadius: 22, backgroundColor: colors.brandSoft },
});
