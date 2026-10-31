import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { postQuickTarget } from "@/lib/social";
import { openQuickActions } from "@/lib/quick-actions";
import { Alert, FlatList, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import { InsetGroup, GroupRow, g } from "@/components/grouped";
import { Badge, Banner, Button, Chip, EmptyState, Icon, Segmented, Skeleton } from "@/components/ui";
import { LinkText, NetworkMark, plainError, postTime, SocialToastHost, TargetRow, useKeyboardLift } from "@/components/social";
import { readBase64 } from "@/lib/chat-files";
import { toNumber } from "@/lib/native-number";
import { useOffline } from "@/lib/offline";
import { success, tick, warning } from "@/lib/haptics";
import {
  DIRECT_NAMES, PHONE_CONNECT_APPS, POST_FILTERS, SOCIAL_IMAGE_MAX_BYTES, SOCIAL_IMAGE_TYPES, SOCIAL_NETWORKS, SOCIAL_TEXT_MAX,
  ago, appName, canPostTo, filterPosts, healthChip, laterOptions, needsDeleteNote, needsReconnect, newPostKey, postBadge, postNote, whyNot,
  type ConnectedAccountView, type DirectAccountView, type PostFilter, type SocialAccountHealth, type SocialPostView,
} from "@/lib/social";
import {
  clearSocialToast, currentSocialTab, openWebSocialAccounts, rememberDraft, subscribeSocialTab, takeRestoredDraft, useDirectStatus, useFreshHealth, useSocialAccounts,
  useSocialActions, useSocialHealth, useSocialPosts, useSocialStatus, useSocialSync, useSocialTargets, type SocialTab,
} from "@/lib/social-queries";
import { colors, font, radius, space } from "@/theme";
import { InboxFilters, InboxTab } from "@/components/social-inbox";
import { capLine, pinBroken, type InboxFilter } from "@/lib/social-inbox";
import { inboxOff, useSocialInbox } from "@/lib/social-queries";

const TABS: { id: SocialTab; label: string }[] = [{ id: "posts", label: "Posts" }, { id: "inbox", label: "Inbox" }, { id: "new", label: "New post" }, { id: "accounts", label: "Accounts" }];
const isTab = (t: string | undefined): t is SocialTab => t === "posts" || t === "inbox" || t === "new" || t === "accounts";

/**
 * Social on the phone: Posts, New post and Accounts, the same three places as the web's Social area.
 *
 * 1.10.6 layout rule (the 1.10.5 cards slid under a large title): this screen has a fixed standard header, a pinned
 * bar under it (the three parts, and the filters on Posts) that never scrolls, and one scrolling list below it with
 * its own insets. Nothing else scrolls. A test guards it (__tests__/social-1106.test.tsx).
 */
export default function Social() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<SocialTab>(isTab(params.tab) ? params.tab : "posts");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [filter, setFilter] = useState<PostFilter>("all");
  const status = useSocialStatus();
  const offline = useOffline();
  const available = !!status.data?.available;
  const posts = useSocialPosts(available);
  const wanted = useSyncExternalStore(subscribeSocialTab, currentSocialTab, currentSocialTab);
  // Another screen can ask for a part (the screen after posting opens Posts or New post), and so can a link.
  const [seen, setSeen] = useState(wanted?.n ?? 0);
  if (wanted && wanted.n !== seen) { setSeen(wanted.n); setTab(wanted.tab); if (wanted.tab === "posts") setFilter("all"); }
  const [param, setParam] = useState(params.tab);
  if (params.tab !== param) { setParam(params.tab); if (isTab(params.tab)) setTab(params.tab); }
  // 1.10.8: the Inbox part shows only where the server has the Social inbox for this workspace.
  const inbox = useSocialInbox(inboxFilter, available);
  const inboxOn = !(inbox.error && inboxOff(inbox.error));
  const tabs = inboxOn ? TABS : TABS.filter((t) => t.id !== "inbox");
  const shown: SocialTab = tab === "inbox" && !inboxOn ? "posts" : tab;

  if (status.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="social-loading"><PostSkeletons /></View>;
  if (status.error || !available) {
    return <EmptyState icon="send" title="Social posting isn't on here yet" body="Once it is switched on for this workspace, you can post to your pages and profiles from here and from multies.si." />;
  }
  const canManage = !!status.data?.canManage;
  const list = posts.data ?? [];
  const count = (f: PostFilter) => filterPosts(list, f).length;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="social">
      <View style={styles.pinned} testID="social-pinned">
        <Segmented label="Social" value={shown} options={tabs} onChange={(v) => { tick(); clearSocialToast(); setTab(v); }} />
        {shown === "inbox" ? <InboxFilters value={inboxFilter} onChange={setInboxFilter} counts={inbox.data?.counts} /> : null}
        {shown === "posts" ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, flexGrow: 1 }} accessibilityLabel="Filter posts" testID="social-filters">
            {POST_FILTERS.map((f) => <FilterChip key={f.id} label={f.label} count={posts.data ? count(f.id) : undefined} selected={filter === f.id} onPress={() => setFilter(f.id)} testID={`filter-${f.id}`} />)}
          </ScrollView>
        ) : null}
        {offline ? <Banner text={shown === "inbox" ? "You're offline. Showing what loaded last. Replies send when you're back." : shown === "new" ? "You're offline. You can post when you're back." : posts.dataUpdatedAt ? `You're offline. Showing what loaded ${ago(new Date(posts.dataUpdatedAt).toISOString())}.` : "You're offline. Posts and accounts load again when you're back."} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        {shown === "inbox" ? <InboxTab filter={inboxFilter} onAccounts={() => setTab("accounts")} /> : null}
        {shown === "posts" ? <PostsTab canManage={canManage} filter={filter} onNew={() => setTab("new")} /> : null}
        {shown === "new" ? <NewPostTab canManage={canManage} offline={offline} onAccounts={() => setTab("accounts")} /> : null}
        {shown === "accounts" ? <AccountsTab canManage={canManage} /> : null}
      </View>
      <SocialToastHost />
    </View>
  );
}

/** A filter with its count, sized to fit four in one row at 375 wide. */
function FilterChip({ label, count, selected, onPress, testID }: { label: string; count?: number; selected: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={count === undefined ? label : `${label}, ${count}`} testID={testID}
      style={[styles.filter, selected && { backgroundColor: colors.brandSoft, borderColor: colors.brandLine }]}>
      <Text style={{ color: selected ? colors.brandHover : colors.muted, fontWeight: "600", fontSize: 13 }} numberOfLines={1}>{label}</Text>
      {count !== undefined ? <Text style={{ color: selected ? colors.brand : colors.subtle, fontSize: 12, fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
    </Pressable>
  );
}

function PostSkeletons() {
  return (
    <View style={{ padding: space.lg, gap: space.md }} accessibilityLabel="Loading posts" accessible>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.card, { gap: space.md }]}>
          <View style={{ flexDirection: "row", gap: space.sm }}><Skeleton width={70} height={20} radius={10} /><Skeleton width={110} height={14} /></View>
          <Skeleton width="90%" /><Skeleton width="60%" />
          <Skeleton width="100%" height={22} /><Skeleton width="100%" height={22} />
        </View>
      ))}
    </View>
  );
}

/* ---------------------------------------------------------------- Posts */


function PostsTab({ canManage, filter, onNew }: { canManage: boolean; filter: PostFilter; onNew: () => void }) {
  const q = useSocialPosts();
  const sync = useSocialSync();
  const insets = useSafeAreaInsets();
  const [pulling, setPulling] = useState(false);
  const synced = useRef(false);
  // On opening Posts (and each time it comes back into view), the posts on screen are checked with Facebook.
  useFocusEffect(useCallback(() => { synced.current = false; }, []));
  useEffect(() => {
    if (q.data && !synced.current) { synced.current = true; sync.mutate(q.data); }
  }, [q.data, sync]);
  const refresh = async () => {
    setPulling(true);
    try { const r = await q.refetch(); await sync.mutateAsync(r.data); } finally { setPulling(false); }
  };
  if (q.isPending) return <PostSkeletons />;
  if (q.error && !q.data) {
    return (
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingBottom: insets.bottom + space.xl }} contentInsetAdjustmentBehavior="never"
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.brand} />} testID="social-posts-error">
        <EmptyState icon="alert-circle" title="Couldn't load posts" body={plainError(q.error)} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} testID="posts-try-again" />} />
      </ScrollView>
    );
  }
  const list = filterPosts(q.data ?? [], filter);
  const label = POST_FILTERS.find((f) => f.id === filter)?.label ?? "";
  return (
    <FlatList
      data={list}
      keyExtractor={(p) => p.id}
      renderItem={({ item }) => <PostCard post={item} canManage={canManage} />}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.md, paddingBottom: insets.bottom + space.xxl, flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.brand} />}
      ListEmptyComponent={
        <EmptyState icon="send" title={filter === "all" ? "No posts yet" : "Nothing here"}
          body={filter === "all" ? "Write a post once and send it to your pages and profiles together." : `No ${label.toLowerCase()} posts right now.`}
          action={filter === "all" && canManage ? <Button label="New post" icon="edit" onPress={onNew} testID="social-empty-new" /> : undefined} />
      }
      testID="social-posts"
    />
  );
}

function PostCard({ post, canManage }: { post: SocialPostView; canManage: boolean }) {
  const { retry, reconnect } = useSocialActions();
  const badge = postBadge(post);
  const note = post.targets.some(needsDeleteNote);
  const doRetry = () => retry.mutate(post.id, { onSuccess: () => success(), onError: (e) => { warning(); Alert.alert("Couldn't try again", plainError(e)); } });
  const open = () => router.push(`/social-post/${post.id}` as never);
  // The card opens the post; the per network buttons sit beside that button, not inside it (no nested buttons).
  return (
    <View style={styles.card} testID={`post-${post.id}`}>
      <Pressable onPress={open} onLongPress={() => openQuickActions(postQuickTarget(post))} delayLongPress={350} accessibilityRole="button" accessibilityHint="Opens the post. Press and hold to copy, share or translate." testID={`open-${post.id}`}
        style={({ pressed }) => [{ gap: space.sm, borderRadius: radius.md }, pressed && { opacity: 0.7 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Badge label={badge.label} tone={badge.tone} />
          <Text style={[font.tiny, { flex: 1 }]} numberOfLines={1}>{postTime(post)}</Text>
        </View>
        <View style={{ flexDirection: "row", gap: space.md, alignItems: "flex-start" }}>
          <Text style={{ flex: 1, color: colors.fg, fontSize: 15, lineHeight: 21 }} numberOfLines={4}>{post.text || "Image only"}</Text>
          {post.imageUrl ? <Image source={{ uri: post.imageUrl }} style={styles.thumb} accessibilityIgnoresInvertColors accessibilityLabel="Post image" /> : null}
        </View>
      </Pressable>
      <View style={{ marginTop: 2 }}>
        {post.targets.map((t, i) => (
          <TargetRow key={`${t.accountId}:${t.target ?? ""}`} t={t} variant="compact" canManage={canManage} last={i === post.targets.length - 1}
            onReconnect={() => reconnect.mutate(t.accountId)} onRetry={doRetry} />
        ))}
      </View>
      {note ? <Pressable onPress={open} accessibilityRole="button" accessibilityHint="Opens the post">
        <Text style={{ color: colors.subtle, fontSize: 13 }}>Deleted on LinkedIn? Delete it here too.</Text>
      </Pressable> : null}
    </View>
  );
}

/* ---------------------------------------------------------------- New post */

interface Picked { name: string; type: string; uri: string; size?: number; base64?: string }
type Chosen = Record<string, { target: string | null; targetName: string | null }>;

function NewPostTab({ canManage, offline, onAccounts }: { canManage: boolean; offline: boolean; onAccounts: () => void }) {
  const accounts = useSocialAccounts();
  const health = useSocialHealth(canManage);
  const { create, reconnect } = useSocialActions();
  const insets = useSafeAreaInsets();
  const { ref: liftRef, lift, keyboardUp } = useKeyboardLift();
  const [text, setText] = useState("");
  const [image, setImage] = useState<Picked | null>(null);
  const [chosen, setChosen] = useState<Chosen>({});
  const [mode, setMode] = useState<"now" | "later">("now");
  const later = useMemo(() => laterOptions(new Date()), []);
  const [laterId, setLaterId] = useState(later[0]!.id);
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(newPostKey);
  const lastSet = useRef<Chosen | null>(null);

  // "Edit post" after a post that didn't go out puts its words and accounts back here.
  useFocusEffect(useCallback(() => {
    const d = takeRestoredDraft();
    if (d) { setText(d.text); setImage(d.image); setChosen(d.chosen); setMode("now"); setKey(newPostKey()); }
  }, []));

  if (!canManage) return <EmptyState icon="lock" title="Only owners and admins can post" body="Ask an owner or admin of this workspace to post, or to change your role." />;
  if (accounts.isPending) return <PostSkeletons />;
  if (accounts.error) return <EmptyState icon="alert-circle" title="Couldn't load your accounts" body={plainError(accounts.error)} action={<Button label="Try again" variant="secondary" onPress={() => accounts.refetch()} />} />;
  const postable = accounts.data.filter((a) => canPostTo(a.app));
  if (!postable.length) {
    return <EmptyState icon="link" title="Connect a page or profile first" body="Connect Facebook Pages, LinkedIn, Instagram and more, then post to them together." action={<Button label="Connect an account" onPress={onAccounts} testID="social-go-accounts" />} />;
  }
  const healthOf = (id: string): SocialAccountHealth | null => health.data?.find((h) => h.accountId === id) ?? null;
  const hasImage = !!image;
  const picked = postable.filter((a) => chosen[a.id] && !whyNot(a, text, hasImage, healthOf(a.id)));
  const missingTarget = picked.find((a) => SOCIAL_NETWORKS[a.app]?.target && !chosen[a.id]?.target);
  const limit = picked.length ? Math.min(...picked.map((a) => SOCIAL_NETWORKS[a.app]?.maxChars ?? SOCIAL_TEXT_MAX), SOCIAL_TEXT_MAX) : SOCIAL_TEXT_MAX;
  const sending = create.isPending;
  const canSend = !offline && !sending && picked.length > 0 && (text.trim().length > 0 || hasImage) && !missingTarget && text.length <= limit;

  const pickImage = async () => {
    setProblem(null);
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: [...SOCIAL_IMAGE_TYPES] });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0]!;
    const type = a.mimeType ?? (/\.png$/i.test(a.name) ? "image/png" : "image/jpeg");
    const size = toNumber(a.size);
    if (!(SOCIAL_IMAGE_TYPES as readonly string[]).includes(type)) { setProblem("Pick a JPEG or PNG image."); return; }
    if (size && size > SOCIAL_IMAGE_MAX_BYTES) { setProblem("That image is over 1 MB. Pick a smaller one."); return; }
    setImage({ name: a.name, type, uri: a.uri, size, base64: a.base64 ?? undefined });
  };

  const send = async () => {
    setProblem(null);
    try {
      let img: { contentType: string; dataB64: string } | null = null;
      if (image) {
        const dataB64 = await readBase64({ name: image.name, uri: image.uri, size: image.size, base64: image.base64 });
        if (dataB64.length > 1_400_000) { setProblem("That image is over 1 MB. Pick a smaller one."); return; }
        img = { contentType: image.type, dataB64 };
      }
      const runAt = mode === "later" ? later.find((l) => l.id === laterId)!.at.toISOString() : null;
      const targets = picked.map((a) => ({ accountId: a.id, target: chosen[a.id]?.target ?? null, targetName: chosen[a.id]?.targetName ?? null }));
      const r = await create.mutateAsync({ key, input: { text, image: img, runAt, targets } });
      success();
      rememberDraft({ text, image, chosen });
      // The composer is cleared before the result shows, so going back never sends the post twice. The accounts stay
      // as last used.
      const keep: Chosen = {};
      for (const a of picked) keep[a.id] = SOCIAL_NETWORKS[a.app]?.target ? { ...chosen[a.id]! } : { target: null, targetName: null };
      lastSet.current = keep;
      setText(""); setImage(null); setChosen(keep); setMode("now");
      setKey(newPostKey());
      router.push(`/social-posted/${r.post.id}` as never);
    } catch (e) {
      warning();
      setProblem(e instanceof Error && e.message ? e.message : "The post didn't save. Try again.");
    }
  };

  const label = sending ? "Posting" : mode === "later" ? "Schedule" : picked.length > 1 ? `Post to ${picked.length}` : "Post now";
  return (
    <View ref={liftRef} style={{ flex: 1, paddingBottom: lift }} testID="social-new-wrap">
      <ScrollView contentContainerStyle={{ paddingTop: space.sm, paddingBottom: space.xl }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="never" testID="social-new">
        <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
          <TextInput value={text} onChangeText={setText} multiline placeholder="What do you want to share?" placeholderTextColor={colors.subtle} editable={!sending}
            accessibilityLabel="Post text" testID="social-text" style={styles.editor} maxLength={SOCIAL_TEXT_MAX} textAlignVertical="top" scrollEnabled={false} />
          {image ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <Image source={{ uri: image.uri }} style={styles.smallThumb} accessibilityIgnoresInvertColors accessibilityLabel="Chosen image" />
              <Text style={[font.tiny, { flex: 1 }]} numberOfLines={1}>{image.name}</Text>
              <LinkText label="Remove" onPress={() => setImage(null)} testID="social-image-remove" />
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <LinkText label="Add an image" onPress={pickImage} testID="social-image" />
              <Text style={[font.tiny, { flex: 1, textAlign: "right" }]}>JPEG or PNG, up to 1 MB</Text>
            </View>
          )}
        </View>

        <InsetGroup header="Post to" footer="Greyed out accounts can't take this post. Each says why.">
          {postable.map((a) => {
            const why = whyNot(a, text, hasImage, healthOf(a.id));
            const on = !!chosen[a.id] && !why;
            const note = on ? postNote(a.app, hasImage) : null;
            return (
              <AccountPick key={a.id} account={a} on={on} why={why} note={note} choice={chosen[a.id] ?? null}
                onToggle={() => setChosen((c) => { const n = { ...c }; if (n[a.id]) delete n[a.id]; else n[a.id] = { target: null, targetName: null }; return n; })}
                onTarget={(target, targetName) => setChosen((c) => ({ ...c, [a.id]: { target, targetName } }))}
                onReconnect={() => reconnect.mutate(a.id)} reconnecting={reconnect.isPending && reconnect.variables === a.id} />
            );
          })}
        </InsetGroup>

        <View style={{ paddingHorizontal: space.lg, gap: space.sm, marginTop: space.xl }}>
          <Text style={g.header} accessibilityRole="header">When</Text>
          <Segmented label="When" value={mode} options={[{ id: "now", label: "Now" }, { id: "later", label: "Later" }]} onChange={setMode} />
          {mode === "later" ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {later.map((l) => <Chip key={l.id} label={l.label} selected={laterId === l.id} onPress={() => setLaterId(l.id)} />)}
            </View>
          ) : null}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: keyboardUp ? space.sm : insets.bottom + space.sm }]} testID="social-footer">
        {problem ? <Banner tone="bad" icon="alert-circle" text={problem} /> : null}
        {missingTarget ? <Text style={[font.tiny, { color: colors.warn }]}>Pick a {SOCIAL_NETWORKS[missingTarget.app]!.target!.label.toLowerCase()} for {appName(missingTarget.app, missingTarget.appName)}.</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          <Text style={[font.tiny, { flex: 1, color: text.length > limit ? colors.bad : colors.subtle, fontVariant: ["tabular-nums"] }]} testID="social-count" numberOfLines={2}>
            {offline ? "You're offline. You can post when you're back." : `${text.length.toLocaleString("en-AU")} of ${limit.toLocaleString("en-AU")}`}
          </Text>
          <Button label={label} icon="send" disabled={!canSend} loading={sending} onPress={send} testID="social-send" style={{ minWidth: 140 }} />
        </View>
      </View>
    </View>
  );
}

function AccountPick({ account, on, why, note, choice, onToggle, onTarget, onReconnect, reconnecting }: {
  account: ConnectedAccountView; on: boolean; why: string | null; note: string | null; choice: { target: string | null; targetName: string | null } | null;
  onToggle: () => void; onTarget: (target: string | null, name: string | null) => void; onReconnect: () => void; reconnecting: boolean;
}) {
  const net = SOCIAL_NETWORKS[account.app];
  const needsTarget = on && net?.target;
  const label = appName(account.app, account.appName);
  const fixable = !!why && /Reconnect/.test(why);
  return (
    <View>
      <View style={[g.row, { paddingHorizontal: 0, paddingRight: 16 }]}>
        <Pressable onPress={why ? undefined : onToggle} disabled={!!why} role="checkbox" aria-checked={on} aria-disabled={!!why}
          accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !!why }}
          accessibilityLabel={[label, account.label, why].filter(Boolean).join(", ")} testID={`pick-${account.app}`}
          style={({ pressed }) => [{ flex: 1, flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: 16, minHeight: 52, opacity: why ? 0.6 : 1 }, pressed && { backgroundColor: colors.hover }]}>
          <View style={[styles.check, on && { backgroundColor: colors.brandFill, borderColor: colors.brandFill }]}>{on ? <Icon name="check" size={14} color={colors.brandFg} /> : null}</View>
          <NetworkMark app={account.app} size={28} muted={!!why} />
          <View style={{ flex: 1, paddingVertical: 10 }}>
            <Text style={g.label} numberOfLines={1}>{account.label ?? label}</Text>
            <Text style={g.sub} numberOfLines={1}>{account.label ? label : " "}</Text>
            {why ? <Text style={[g.sub, { color: colors.warn }]} testID={`why-${account.app}`}>{why}</Text> : null}
            {note ? <Text style={g.sub} testID={`note-${account.app}`}>{note}</Text> : null}
          </View>
        </Pressable>
        {fixable ? <Button label="Reconnect" variant="secondary" loading={reconnecting} onPress={onReconnect} testID={`reconnect-${account.app}`} style={{ minHeight: 44, paddingHorizontal: 12 }} /> : null}
      </View>
      {needsTarget ? <TargetPicker accountId={account.id} kind={net!.target!} choice={choice} onTarget={onTarget} /> : null}
    </View>
  );
}

function TargetPicker({ accountId, kind, choice, onTarget }: { accountId: string; kind: { kind: string; label: string }; choice: { target: string | null } | null; onTarget: (t: string | null, n: string | null) => void }) {
  const q = useSocialTargets(kind.kind === "subreddit" ? null : accountId);
  // One Page or board: picked for you.
  useEffect(() => {
    if (q.data && q.data.length === 1 && !choice?.target) onTarget(q.data[0]!.id, q.data[0]!.name);
  }, [q.data, choice?.target, onTarget]);
  if (kind.kind === "subreddit") {
    return (
      <View style={{ paddingLeft: 92, paddingRight: space.lg, paddingBottom: space.md }}>
        <TextInput value={choice?.target ?? ""} onChangeText={(v) => { const n = v.replace(/^r\//, "").trim(); onTarget(n || null, n ? `r/${n}` : null); }}
          placeholder="Community name, for example smallbusiness" placeholderTextColor={colors.subtle} autoCapitalize="none" autoCorrect={false}
          accessibilityLabel="Community" style={styles.input} testID="target-subreddit" />
      </View>
    );
  }
  return (
    <View style={{ paddingLeft: 92, paddingRight: space.lg, paddingBottom: space.md, gap: space.xs }}>
      {q.isPending ? <Text style={font.tiny}>Finding your {kind.label.toLowerCase()}s</Text>
        : q.error ? <Text style={[font.tiny, { color: colors.bad }]}>{plainError(q.error)}</Text>
        : q.data.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {q.data.map((t) => <Chip key={t.id} label={t.name} selected={choice?.target === t.id} onPress={() => onTarget(t.id, t.name)} />)}
          </View>
        ) : <Text style={font.tiny}>No {kind.label.toLowerCase()}s found for this account. Check it on the web.</Text>}
    </View>
  );
}

/* ---------------------------------------------------------------- Accounts */

function AccountsTab({ canManage }: { canManage: boolean }) {
  const accounts = useSocialAccounts();
  const direct = useDirectStatus();
  const health = useSocialHealth(true);
  const fresh = useFreshHealth();
  const insets = useSafeAreaInsets();
  const { connect, reconnect } = useSocialActions();
  const [pulling, setPulling] = useState(false);
  if (accounts.isPending) return <PostSkeletons />;
  if (accounts.error) return <EmptyState icon="alert-circle" title="Couldn't load your accounts" body={plainError(accounts.error)} action={<Button label="Try again" variant="secondary" onPress={() => accounts.refetch()} />} />;
  const social = accounts.data.filter((a) => canPostTo(a.app));
  const connectedApps = new Set(social.map((a) => a.app));
  const toConnect = PHONE_CONNECT_APPS.filter((a) => !connectedApps.has(a));
  const directs = (direct.data?.accounts ?? []).filter((d) => d.available || d.connected);
  const doConnect = (app: string) => connect.mutate(app, { onError: (e) => { warning(); Alert.alert("Couldn't start the sign in", plainError(e)); } });
  const doReconnect = (id: string) => reconnect.mutate(id, { onError: (e) => { warning(); Alert.alert("Couldn't reconnect", plainError(e)); } });
  const refresh = async () => {
    setPulling(true);
    try { await Promise.all([accounts.refetch(), direct.refetch(), fresh.mutateAsync()]); } finally { setPulling(false); }
  };
  const checked = health.dataUpdatedAt ? ago(new Date(Math.max(health.dataUpdatedAt, fresh.submittedAt || 0)).toISOString()) : null;
  return (
    <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.brand} />} testID="social-accounts">
      {social.length ? (
        <InsetGroup header="Connected" footer={checked ? `Checked ${checked}. Pull down to check again.` : "Pull down to check your accounts again."}>
          {pinBroken(social, (a) => { const c = healthChip(a, health.data?.find((x) => x.accountId === a.id) ?? null).label; return c !== "Ready to post" && c !== "Off"; }).map((a) => {
            const h = health.data?.find((x) => x.accountId === a.id) ?? null;
            const chip = healthChip(a, h);
            const problem = chip.label !== "Ready to post" && chip.label !== "Off";
            const line = needsReconnect(a) ? "Sign in needs renewing before you can post." : problem ? (h?.text ?? "Reconnect to post here.") : null;
            return (
              <View key={a.id} style={[g.row, { gap: space.md, alignItems: "center", minHeight: 60 }]} testID={`account-${a.app}`}>
                <NetworkMark app={a.app} size={30} muted={a.status === "disabled"} />
                <View style={{ flex: 1, paddingVertical: 10, gap: 1 }}>
                  <Text style={g.label} numberOfLines={1}>{a.label ?? appName(a.app, a.appName)}</Text>
                  <Text style={g.sub} numberOfLines={1}>{appName(a.app, a.appName)}</Text>
                  <Text style={[g.sub, { color: colors.subtle }]} testID={`account-caps-${a.app}`}>{capLine(a.app)}</Text>
                  {line ? <Text style={[g.sub, { color: colors.warn }]}>{line}</Text> : null}
                </View>
                {problem && canManage
                  ? <Button label="Reconnect" variant="secondary" loading={reconnect.isPending && reconnect.variables === a.id} onPress={() => doReconnect(a.id)} testID={`account-reconnect-${a.app}`} style={{ minHeight: 44, paddingHorizontal: 12 }} />
                  : <Badge label={chip.label} tone={chip.tone} />}
              </View>
            );
          })}
        </InsetGroup>
      ) : (
        <View style={{ paddingTop: space.lg }}>
          <EmptyState icon="link" title="No accounts yet" body="Connect a Facebook Page, LinkedIn and more, then post to them together." />
        </View>
      )}

      {directs.length || (canManage && toConnect.length) ? (
        <InsetGroup header="Add more" footer="You sign in with the network in your browser, then come back here. TikTok and Threads sign in on multies.si.">
          {directs.map((d) => <DirectRow key={d.provider} d={d} canManage={canManage && !!direct.data?.canManage} />)}
          {canManage ? toConnect.map((app) => (
            <GroupRow key={app} label={appName(app)} sub={postsTo(app)} testID={`connect-${app}`}
              right={<Button label="Connect" variant="secondary" loading={connect.isPending && connect.variables === app} onPress={() => doConnect(app)} style={{ minHeight: 44, paddingHorizontal: 12 }} />} />
          )) : null}
        </InsetGroup>
      ) : null}
      {!canManage ? <View style={{ padding: space.lg }}><Banner tone="neutral" icon="info" text="Only owners and admins can connect or reconnect accounts." /></View> : null}
      <InsetGroup>
        <GroupRow icon="external-link" label="More apps on multies.si" onPress={() => { void openWebSocialAccounts(); }} testID="social-more-web" />
      </InsetGroup>
    </ScrollView>
  );
}

function DirectRow({ d, canManage }: { d: DirectAccountView; canManage: boolean }) {
  const name = DIRECT_NAMES[d.provider];
  const expired = d.connected && d.status === "expired";
  const sub = d.connected
    ? `${d.username ? `@${d.username}` : d.displayName ?? "Connected"}${expired ? ". Sign in expired." : ""}`
    : d.testMode ? "Test mode: only approved test accounts can connect for now." : "Not connected";
  return (
    <GroupRow label={name} sub={sub} testID={`direct-${d.provider}`}
      right={d.connected && !expired
        ? <Centered><Badge label="Ready to post" tone="ok" /></Centered>
        : canManage ? <Button label={expired ? "Reconnect" : "Connect"} variant="secondary" onPress={() => { void openWebSocialAccounts(); }} testID={`direct-connect-${d.provider}`} style={{ minHeight: 44, paddingHorizontal: 12 }} />
        : <Centered><Badge label={expired ? "Sign in expired" : "Not connected"} tone={expired ? "warn" : "neutral"} /></Centered>} />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={{ alignSelf: "center", justifyContent: "center" }}>{children}</View>;
}

const PLURAL: Record<string, string> = { page: "Pages", board: "boards", subreddit: "communities" };
const postsTo = (app: string) => { const t = SOCIAL_NETWORKS[app]?.target; return t ? `Posts to your ${PLURAL[t.kind] ?? "pages"}` : "Posts to your profile"; };

const styles = StyleSheet.create({
  pinned: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm, gap: space.sm, backgroundColor: colors.bg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, zIndex: 1 },
  filter: { flexGrow: 1, flexShrink: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 34, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  thumb: { width: 64, height: 64, borderRadius: radius.md, backgroundColor: colors.elevated },
  smallThumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.elevated },
  editor: { minHeight: 150, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, padding: space.md, color: colors.fg, fontSize: 17, lineHeight: 22 },
  input: { minHeight: 44, backgroundColor: colors.elevated, borderRadius: radius.md, paddingHorizontal: space.md, color: colors.fg, fontSize: 16 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
  footer: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm, backgroundColor: colors.bg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
});
