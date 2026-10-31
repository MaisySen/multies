import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, EmptyState, Icon } from "@/components/ui";
import { plainError, postTime, SocialToastHost, TargetRow } from "@/components/social";
import { success, warning } from "@/lib/haptics";
import { resultTitle, SOCIAL_NETWORKS, stillSending } from "@/lib/social";
import { requestSocialTab, restoreLastDraft, showSocialToast, useSocialActions, useSocialPost, useSocialStatus } from "@/lib/social-queries";
import { colors, radius, space } from "@/theme";

/** How long the screen follows a post set for now before it says it is still going (the server keeps sending). */
const FOLLOW_MS = 90_000;

/**
 * 1.10.6: the screen after Post now. It follows each network to its tick (the server sends right after it saves the
 * post), then says plainly what happened: "Posted to Facebook", "Posted to all 2 accounts", "Posted to 1 of 2
 * accounts" or "Not posted", the same words as the web. Each row has Open post, or the network's own reason with
 * Reconnect and Try again. The composer was already cleared, so going back never sends it twice.
 */
export default function SocialPosted() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useSocialPost(id, { follow: true });
  const status = useSocialStatus();
  const insets = useSafeAreaInsets();
  const { retry, reconnect } = useSocialActions();
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const canManage = !!status.data?.canManage;
  const post = q.data;
  const busy = !!post && stillSending(post);
  useEffect(() => {
    if (!busy) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [busy]);
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!post || busy) return;
    const key = `${post.status}:${post.targets.map((t) => t.status).join(",")}`;
    if (announced.current === key) return;
    announced.current = key;
    if (post.status === "done" || post.status === "scheduled") success(); else warning();
  }, [post, busy]);

  const toPosts = () => { requestSocialTab("posts"); router.back(); };
  const writeAnother = () => { requestSocialTab("new"); router.back(); };
  const editPost = () => { restoreLastDraft(); requestSocialTab("new"); router.back(); };
  const doRetry = () => post && retry.mutate(post.id, { onError: (e) => { warning(); showSocialToast(`Couldn't try again. ${plainError(e)}`, "bad"); } });

  const header = <Stack.Screen options={{ title: "", headerBackVisible: false, gestureEnabled: false, headerRight: () => (
    <Pressable onPress={toPosts} accessibilityRole="button" accessibilityLabel="Done" hitSlop={10} testID="posted-done" style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 4 }}>
      <Text style={{ color: colors.brand, fontSize: 17, fontWeight: "600" }}>Done</Text>
    </Pressable>
  ) }} />;

  if (!post) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {header}
        {q.isPending ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator color={colors.brand} /></View>
          : <EmptyState icon="alert-circle" title="Couldn't load the result" body={`${plainError(q.error)} Your post is saved. See it in Posts.`} action={<Button label="View in Posts" onPress={toPosts} />} />}
      </View>
    );
  }
  const slow = busy && now - started > FOLLOW_MS;
  const ok = post.targets.filter((t) => t.status === "sent").length;
  const title = slow ? "Still posting" : resultTitle(post, now);
  const tone = busy ? "brand" : post.status === "done" || post.status === "scheduled" ? "ok" : post.status === "partial" ? "warn" : "bad";
  const sub = busy
    ? slow ? "The networks are taking longer than usual. Multies keeps going, and Posts shows the result." : "Sending to each network now. This takes a few seconds."
    : post.status === "scheduled" ? postTime(post)
    : post.status === "done" ? (ok === 1 ? "Your post is live. Open it to see it there." : `Your post is live on all ${ok}. Open each one to see it there.`)
    : post.status === "partial" ? "One or more networks didn't take it. The reason is below each one."
    : "Nothing went out. The reasons are below.";
  const bg = { brand: colors.brandSoft, ok: colors.okSoft, warn: colors.warnSoft, bad: colors.badSoft }[tone];
  const fg = { brand: colors.brand, ok: colors.ok, warn: colors.warn, bad: colors.bad }[tone];
  const failed = !busy && (post.status === "failed" || post.status === "partial");

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="social-posted">
      {header}
      <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={{ padding: space.lg, gap: space.xl, paddingBottom: insets.bottom + space.xxl }}>
        <View style={{ alignItems: "center", gap: space.sm, paddingTop: space.md }} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${title}. ${sub}`}>
          <View style={[styles.mark, { backgroundColor: bg }]}>
            {busy ? <ActivityIndicator color={fg} /> : <Icon name={post.status === "done" ? "check" : post.status === "scheduled" ? "clock" : "alert-circle"} size={34} color={fg} />}
          </View>
          <Text style={{ color: colors.fg, fontSize: 24, fontWeight: "700", textAlign: "center" }} accessibilityRole="header" testID="posted-title">{title}</Text>
          <Text style={{ color: colors.muted, fontSize: 15, lineHeight: 21, textAlign: "center", maxWidth: 320 }}>{sub}</Text>
        </View>

        <View style={styles.card}>
          {post.targets.map((t, i) => (
            <TargetRow key={`${t.accountId}:${t.target ?? ""}`} t={t} variant="full" canManage={canManage} last={i === post.targets.length - 1}
              textOnly={!!post.imageUrl && SOCIAL_NETWORKS[t.app]?.image === "none"}
              onReconnect={() => reconnect.mutate(t.accountId)} reconnecting={reconnect.isPending && reconnect.variables === t.accountId}
              onRetry={doRetry} retrying={retry.isPending} />
          ))}
        </View>

        <View style={{ gap: space.sm }}>
          <Button label="View in Posts" onPress={toPosts} testID="view-in-posts" />
          {failed && post.status === "failed" ? <Button label="Edit post" variant="secondary" icon="edit" onPress={editPost} testID="posted-edit" /> : null}
          <Button label="Write another" variant="secondary" onPress={writeAnother} testID="write-another" />
        </View>
      </ScrollView>
      <SocialToastHost />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center" },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, paddingHorizontal: space.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
});
