import { useEffect, useRef, useState } from "react";
import { Image, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { ConfirmSheet, plainError, postTime, Section, SocialToastHost, TargetRow } from "@/components/social";
import { useOffline } from "@/lib/offline";
import { success, warning } from "@/lib/haptics";
import { checkedLine, deleteConfirm, deleteMessage, imageDropNote, postBadge, postedCount, SOCIAL_NETWORKS } from "@/lib/social";
import { showSocialToast, useSocialActions, useSocialPost, useSocialStatus, useSocialSync } from "@/lib/social-queries";
import { colors, radius, space } from "@/theme";

/**
 * 1.10.6: one post. Where it went (each network with its chip, time, Open post, the network's own reason, Reconnect
 * and Try again), a removed state when Facebook says the post was deleted there, and Delete, which also deletes it on
 * Facebook and LinkedIn after a confirm. Opening it checks the post with Facebook (the server holds it to once per
 * 5 minutes).
 */
export default function SocialPost() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useSocialPost(id, { follow: true });
  const status = useSocialStatus();
  const sync = useSocialSync();
  const offline = useOffline();
  const insets = useSafeAreaInsets();
  const { retry, cancel, reconnect, remove } = useSocialActions();
  const [confirm, setConfirm] = useState(false);
  const [pulling, setPulling] = useState(false);
  const synced = useRef(false);
  const canManage = !!status.data?.canManage;
  useEffect(() => {
    if (q.data && !synced.current) { synced.current = true; sync.mutate([q.data]); }
  }, [q.data, sync]);

  if (!q.data) {
    if (q.isPending) {
      return (
        <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.lg, gap: space.md }} testID="post-loading">
          <Skeleton width="100%" height={180} radius={radius.lg} /><Skeleton width="100%" height={120} radius={radius.lg} />
        </View>
      );
    }
    return (
      <EmptyState icon="alert-circle" title="Couldn't open this post" body={q.error ? plainError(q.error) : "It may have been deleted."}
        action={<Button label="Back to Social" variant="secondary" onPress={() => router.back()} />} />
    );
  }
  const post = q.data;
  const badge = postBadge(post);
  const count = postedCount(post);
  const drop = imageDropNote(post);
  const checked = checkedLine(post);
  const anyFailed = post.targets.some((t) => t.status === "failed");
  const c = deleteConfirm(post);
  const doRetry = () => retry.mutate(post.id, { onSuccess: () => success(), onError: (e) => { warning(); showSocialToast(`Couldn't try again. ${plainError(e)}`, "bad"); } });
  const doDelete = () => remove.mutate(post.id, {
    onSuccess: (r) => {
      const m = deleteMessage(r);
      setConfirm(false);
      if (m.ok) { success(); showSocialToast(m.text, "ok"); router.back(); }
      else { warning(); showSocialToast(m.text, "bad"); }
    },
    onError: (e) => { warning(); setConfirm(false); showSocialToast(`Couldn't delete it. ${plainError(e)}`, "bad"); },
  });
  const refresh = async () => {
    setPulling(true);
    try { const r = await q.refetch(); if (r.data) await sync.mutateAsync([r.data]); } finally { setPulling(false); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="social-post">
      <Stack.Screen options={{ title: "Post" }} />
      <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={{ padding: space.lg, gap: space.xl, paddingBottom: insets.bottom + space.xxl * 2 }}
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.brand} />}>
        <View style={styles.card}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
            <Badge label={badge.label} tone={badge.tone} />
            {count ? <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }} testID="posted-count">{count}</Text> : null}
            <Text style={{ color: colors.subtle, fontSize: 13, flex: 1, textAlign: "right" }} numberOfLines={1}>{postTime(post)}</Text>
          </View>
          <Text style={{ color: colors.fg, fontSize: 16, lineHeight: 23 }} selectable testID="post-text">{post.text || "Image only"}</Text>
          {post.imageUrl ? <Image source={{ uri: post.imageUrl }} style={styles.image} resizeMode="cover" accessibilityIgnoresInvertColors accessibilityLabel="Post image" /> : null}
          {drop ? <Text style={{ color: colors.subtle, fontSize: 13, lineHeight: 18 }} testID="image-drop-note">{drop}</Text> : null}
        </View>

        <Section title="Where it went">
          <View style={[styles.card, { paddingVertical: 0 }]}>
            {post.targets.map((t, i) => (
              <TargetRow key={`${t.accountId}:${t.target ?? ""}`} t={t} variant="full" canManage={canManage} last={i === post.targets.length - 1}
                time={t.sentAt ? new Date(t.sentAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null}
                textOnly={!!post.imageUrl && SOCIAL_NETWORKS[t.app]?.image === "none"}
                onReconnect={() => reconnect.mutate(t.accountId)} reconnecting={reconnect.isPending && reconnect.variables === t.accountId}
                onRetry={doRetry} retrying={retry.isPending} />
            ))}
          </View>
        </Section>

        {canManage ? (
          <View style={{ gap: space.sm }}>
            {anyFailed ? <Button label="Try again" icon="refresh-cw" variant="secondary" loading={retry.isPending} disabled={offline} onPress={doRetry} testID="post-retry" /> : null}
            {post.status === "scheduled" ? <Button label="Cancel post" variant="secondary" loading={cancel.isPending} disabled={offline} onPress={() => cancel.mutate(post.id)} testID="post-cancel" /> : null}
            {post.status !== "sending" ? <Button label="Delete post" icon="trash-2" variant="danger" disabled={offline || remove.isPending} onPress={() => setConfirm(true)} testID="post-delete" /> : null}
          </View>
        ) : null}
        {checked ? <Text style={{ color: colors.subtle, fontSize: 13, textAlign: "center" }} testID="checked-line">{checked}</Text> : null}
        {offline ? <Text style={{ color: colors.subtle, fontSize: 13, textAlign: "center" }}>{"You're offline. Delete and Try again work when you're back."}</Text> : null}
      </ScrollView>
      <ConfirmSheet visible={confirm} title={c.title} body={c.body} confirmLabel={c.button} busy={remove.isPending}
        onConfirm={doDelete} onClose={() => setConfirm(false)} testID="delete-sheet" />
      <SocialToastHost />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  image: { width: "100%", aspectRatio: 1.6, borderRadius: radius.md, backgroundColor: colors.elevated },
});
