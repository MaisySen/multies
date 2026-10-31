import { useMemo, useState } from "react";
import { Alert, Image, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { InsetGroup, GroupRow, g } from "@/components/grouped";
import { Badge, Banner, Button, Chip, EmptyState, Icon, Loading, Segmented } from "@/components/ui";
import { readBase64 } from "@/lib/chat-files";
import { toNumber } from "@/lib/native-number";
import { useOffline } from "@/lib/offline";
import { success, warning } from "@/lib/haptics";
import {
  DIRECT_NAMES, PHONE_CONNECT_APPS, POST_STATUS, SOCIAL_IMAGE_MAX_BYTES, SOCIAL_IMAGE_TYPES, SOCIAL_NETWORKS, SOCIAL_TEXT_MAX, TARGET_STATUS,
  appName, canPostTo, filterPosts, laterOptions, needsReconnect, newPostKey, postNote, socialErrorText, whyNot,
  type ConnectedAccountView, type DirectAccountView, type PostFilter, type SocialAccountHealth, type SocialPostView,
} from "@/lib/social";
import {
  openWebSocialAccounts, useDirectStatus, useSocialAccounts, useSocialActions, useSocialHealth, useSocialPosts, useSocialStatus, useSocialTargets,
} from "@/lib/social-queries";
import { colors, font, radius, space } from "@/theme";

type Tab = "posts" | "new" | "accounts";
const TABS: { id: Tab; label: string }[] = [{ id: "posts", label: "Posts" }, { id: "new", label: "New post" }, { id: "accounts", label: "Accounts" }];

/**
 * 1.10.5: Social on the phone, the same three places as the web's Social area: Posts (sent, scheduled and
 * not posted, with each network's own reason and a Reconnect button), New post, and Accounts.
 */
export default function Social() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(params.tab === "new" || params.tab === "accounts" ? params.tab : "posts");
  const status = useSocialStatus();
  const offline = useOffline();
  if (status.isPending) return <Loading variant="task" />;
  if (status.error || !status.data?.available) {
    return <EmptyState icon="send" title="Social posting isn't on here yet" body="Once it is switched on for this workspace, you can post to your pages and profiles from here and from multies.si." />;
  }
  const canManage = status.data.canManage;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="social">
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm, gap: space.sm }}>
        <Segmented label="Social" value={tab} options={TABS} onChange={setTab} />
        {offline ? <Banner text="You're offline. Posts and accounts load again when you're back." /> : null}
      </View>
      {tab === "posts" ? <PostsTab canManage={canManage} onNew={() => setTab("new")} /> : null}
      {tab === "new" ? <NewPostTab canManage={canManage} onPosted={() => setTab("posts")} onAccounts={() => setTab("accounts")} /> : null}
      {tab === "accounts" ? <AccountsTab canManage={canManage} /> : null}
    </View>
  );
}

/* ---------------------------------------------------------------- Posts */

const FILTERS: { id: PostFilter; label: string }[] = [{ id: "all", label: "All" }, { id: "scheduled", label: "Scheduled" }, { id: "sent", label: "Posted" }, { id: "failed", label: "Not posted" }];

function PostsTab({ canManage, onNew }: { canManage: boolean; onNew: () => void }) {
  const q = useSocialPosts();
  const [filter, setFilter] = useState<PostFilter>("all");
  if (q.isPending) return <Loading variant="task" />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load posts" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const list = filterPosts(q.data, filter);
  return (
    <ScrollView contentContainerStyle={{ padding: space.lg, paddingTop: space.xs, gap: space.md, paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="social-posts">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
        {FILTERS.map((f) => <Chip key={f.id} label={f.label} selected={filter === f.id} onPress={() => setFilter(f.id)} />)}
      </ScrollView>
      {list.length ? list.map((p) => <PostCard key={p.id} post={p} canManage={canManage} />) : (
        <EmptyState icon="send" title={filter === "all" ? "No posts yet" : "Nothing here"}
          body={filter === "all" ? "Write a post once and send it to your pages and profiles together." : "Posts show here when they match this filter."}
          action={filter === "all" && canManage ? <Button label="New post" icon="edit" onPress={onNew} testID="social-empty-new" /> : undefined} />
      )}
    </ScrollView>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function PostCard({ post, canManage }: { post: SocialPostView; canManage: boolean }) {
  const { retry, cancel, reconnect } = useSocialActions();
  const s = POST_STATUS[post.status];
  const failed = post.targets.some((t) => t.status === "failed");
  const timeLine = post.status === "scheduled" ? `Goes out ${when(post.runAt)}` : when(post.runAt);
  return (
    <View style={styles.card} testID={`post-${post.id}`}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Badge label={s.label} tone={s.tone} />
        <Text style={[font.tiny, { flex: 1 }]} numberOfLines={1}>{timeLine}</Text>
      </View>
      <Text style={{ color: colors.fg, fontSize: 15, lineHeight: 20 }} numberOfLines={4}>{post.text || "Image only"}</Text>
      {post.imageUrl ? <Image source={{ uri: post.imageUrl }} style={styles.thumb} accessibilityIgnoresInvertColors accessibilityLabel="Post image" /> : null}
      <View style={{ gap: space.sm, marginTop: space.xs }}>
        {post.targets.map((t) => {
          const err = t.status === "failed" ? socialErrorText(t.error) : null;
          const where = [appName(t.app, t.label), t.targetName ?? t.label].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ");
          return (
            <View key={`${t.accountId}:${t.target ?? ""}`} style={styles.target} testID={`post-target-${t.app}`}>
              <Icon name={t.status === "sent" ? "check-circle" : t.status === "failed" ? "alert-circle" : "clock"} size={16}
                color={t.status === "sent" ? colors.ok : t.status === "failed" ? colors.bad : colors.subtle} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }} numberOfLines={1}>{where}</Text>
                <Text style={{ color: err ? colors.bad : colors.subtle, fontSize: 13, lineHeight: 18 }} testID={err ? "post-error" : undefined}>
                  {err ? err.text : TARGET_STATUS[t.status]}
                </Text>
                <View style={{ flexDirection: "row", gap: space.md, flexWrap: "wrap" }}>
                  {t.url ? <LinkText label="Open post" onPress={() => Linking.openURL(t.url!)} /> : null}
                  {err?.reconnect && canManage ? <LinkText label={`Reconnect ${appName(t.app)}`} testID="post-reconnect" onPress={() => reconnect.mutate(t.accountId)} /> : null}
                </View>
              </View>
            </View>
          );
        })}
      </View>
      {canManage && (failed || post.status === "scheduled") ? (
        <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.xs }}>
          {failed ? <Button label="Try again" icon="refresh-cw" variant="secondary" loading={retry.isPending && retry.variables === post.id}
            onPress={() => retry.mutate(post.id, { onSuccess: () => success(), onError: (e) => { warning(); Alert.alert("Couldn't try again", e.message); } })} testID="post-retry" style={{ flex: 1 }} /> : null}
          {post.status === "scheduled" ? <Button label="Cancel post" variant="ghost" loading={cancel.isPending && cancel.variables === post.id}
            onPress={() => Alert.alert("Cancel this post?", "It won't go out. You can write it again later.", [{ text: "Keep it", style: "cancel" }, { text: "Cancel post", style: "destructive", onPress: () => cancel.mutate(post.id) }])}
            testID="post-cancel" style={{ flex: 1 }} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function LinkText({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={10} testID={testID} style={{ minHeight: 28, justifyContent: "center" }}>
      <Text style={{ color: colors.brand, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

/* ---------------------------------------------------------------- New post */

interface Picked { name: string; type: string; uri: string; size?: number; base64?: string }

function NewPostTab({ canManage, onPosted, onAccounts }: { canManage: boolean; onPosted: () => void; onAccounts: () => void }) {
  const accounts = useSocialAccounts();
  const health = useSocialHealth(canManage);
  const { create, reconnect } = useSocialActions();
  const [text, setText] = useState("");
  const [image, setImage] = useState<Picked | null>(null);
  const [chosen, setChosen] = useState<Record<string, { target: string | null; targetName: string | null }>>({});
  const [mode, setMode] = useState<"now" | "later">("now");
  const later = useMemo(() => laterOptions(new Date()), []);
  const [laterId, setLaterId] = useState(later[0]!.id);
  const [problem, setProblem] = useState<string | null>(null);
  const [key, setKey] = useState(newPostKey);

  if (!canManage) return <EmptyState icon="lock" title="Only owners and admins can post" body="Ask an owner or admin of this workspace to post, or to change your role." />;
  if (accounts.isPending) return <Loading variant="task" />;
  if (accounts.error) return <EmptyState icon="alert-circle" title="Couldn't load your accounts" body={accounts.error.message} action={<Button label="Try again" variant="secondary" onPress={() => accounts.refetch()} />} />;
  const postable = accounts.data.filter((a) => canPostTo(a.app));
  if (!postable.length) {
    return <EmptyState icon="link" title="Connect a page or profile first" body="Connect Facebook Pages, LinkedIn, Instagram and more, then post to them together." action={<Button label="Connect an account" onPress={onAccounts} testID="social-go-accounts" />} />;
  }
  const healthOf = (id: string): SocialAccountHealth | null => health.data?.find((h) => h.accountId === id) ?? null;
  const hasImage = !!image;
  const picked = postable.filter((a) => chosen[a.id] && !whyNot(a, text, hasImage, healthOf(a.id)));
  const missingTarget = picked.find((a) => SOCIAL_NETWORKS[a.app]?.target && !chosen[a.id]?.target);
  const canSend = picked.length > 0 && (text.trim().length > 0 || hasImage) && !missingTarget && text.length <= SOCIAL_TEXT_MAX;

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
      await create.mutateAsync({ key, input: { text, image: img, runAt, targets: picked.map((a) => ({ accountId: a.id, target: chosen[a.id]?.target ?? null, targetName: chosen[a.id]?.targetName ?? null })) } });
      success();
      setText(""); setImage(null); setChosen({}); setMode("now");
      setKey(newPostKey());
      onPosted();
    } catch (e) {
      warning();
      setProblem(e instanceof Error ? e.message : "The post didn't save. Try again.");
    }
  };

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: space.xxl * 3 }} keyboardShouldPersistTaps="handled" testID="social-new">
      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <TextInput value={text} onChangeText={setText} multiline placeholder="What do you want to share?" placeholderTextColor={colors.subtle}
          accessibilityLabel="Post text" testID="social-text" style={styles.editor} maxLength={SOCIAL_TEXT_MAX} textAlignVertical="top" />
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {image ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flex: 1 }}>
              <Image source={{ uri: image.uri }} style={styles.smallThumb} accessibilityIgnoresInvertColors accessibilityLabel="Chosen image" />
              <Text style={[font.tiny, { flex: 1 }]} numberOfLines={1}>{image.name}</Text>
              <LinkText label="Remove" onPress={() => setImage(null)} testID="social-image-remove" />
            </View>
          ) : <View style={{ flex: 1 }}><LinkText label="Add an image" onPress={pickImage} testID="social-image" /></View>}
          <Text style={font.tiny}>{text.length} characters</Text>
        </View>
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
        {problem ? <Banner tone="bad" icon="alert-circle" text={problem} /> : null}
        {missingTarget ? <Text style={[font.tiny, { color: colors.warn }]}>Pick a {SOCIAL_NETWORKS[missingTarget.app]!.target!.label.toLowerCase()} for {appName(missingTarget.app, missingTarget.appName)}.</Text> : null}
        <Button label={mode === "now" ? (picked.length > 1 ? `Post to ${picked.length} accounts` : "Post now") : "Schedule post"} icon="send"
          disabled={!canSend} loading={create.isPending} onPress={send} testID="social-send" />
      </View>
    </ScrollView>
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
      <Pressable onPress={why ? undefined : onToggle} disabled={!!why} accessibilityRole="checkbox" accessibilityState={{ checked: on, disabled: !!why }}
        accessibilityLabel={[label, account.label, why].filter(Boolean).join(", ")} testID={`pick-${account.app}`}
        style={({ pressed }) => [g.row, { opacity: why ? 0.6 : 1 }, pressed && { backgroundColor: colors.hover }]}>
        <View style={[styles.check, on && { backgroundColor: colors.brandFill, borderColor: colors.brandFill }]}>{on ? <Icon name="check" size={14} color={colors.brandFg} /> : null}</View>
        <View style={{ flex: 1, paddingVertical: 10 }}>
          <Text style={g.label} numberOfLines={1}>{label}</Text>
          {account.label ? <Text style={g.sub} numberOfLines={1}>{account.label}</Text> : null}
          {why ? <Text style={[g.sub, { color: colors.warn }]} testID={`why-${account.app}`}>{why}</Text> : null}
          {note ? <Text style={g.sub}>{note}</Text> : null}
        </View>
        {fixable ? <Button label="Reconnect" variant="secondary" loading={reconnecting} onPress={onReconnect} testID={`reconnect-${account.app}`} style={{ minHeight: 36, paddingHorizontal: 12 }} /> : null}
      </Pressable>
      {needsTarget ? <TargetPicker accountId={account.id} kind={net!.target!} choice={choice} onTarget={onTarget} /> : null}
    </View>
  );
}

function TargetPicker({ accountId, kind, choice, onTarget }: { accountId: string; kind: { kind: string; label: string }; choice: { target: string | null } | null; onTarget: (t: string | null, n: string | null) => void }) {
  const q = useSocialTargets(kind.kind === "subreddit" ? null : accountId);
  if (kind.kind === "subreddit") {
    return (
      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
        <TextInput value={choice?.target ?? ""} onChangeText={(v) => { const n = v.replace(/^r\//, "").trim(); onTarget(n || null, n ? `r/${n}` : null); }}
          placeholder="Community name, for example smallbusiness" placeholderTextColor={colors.subtle} autoCapitalize="none" autoCorrect={false}
          accessibilityLabel="Community" style={styles.input} testID="target-subreddit" />
      </View>
    );
  }
  return (
    <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.xs }}>
      {q.isPending ? <Text style={font.tiny}>Finding your {kind.label.toLowerCase()}s</Text>
        : q.error ? <Text style={[font.tiny, { color: colors.bad }]}>{q.error.message}</Text>
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
  const { connect, reconnect } = useSocialActions();
  if (accounts.isPending) return <Loading variant="task" />;
  if (accounts.error) return <EmptyState icon="alert-circle" title="Couldn't load your accounts" body={accounts.error.message} action={<Button label="Try again" variant="secondary" onPress={() => accounts.refetch()} />} />;
  const social = accounts.data.filter((a) => canPostTo(a.app));
  const connectedApps = new Set(social.map((a) => a.app));
  const toConnect = PHONE_CONNECT_APPS.filter((a) => !connectedApps.has(a));
  const directs = (direct.data?.accounts ?? []).filter((d) => d.available || d.connected);
  const doConnect = (app: string) => connect.mutate(app, { onError: (e) => { warning(); Alert.alert("Couldn't start the sign in", e.message); } });
  const doReconnect = (id: string) => reconnect.mutate(id, { onError: (e) => { warning(); Alert.alert("Couldn't reconnect", e.message); } });
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: space.xxl * 2 }}
      refreshControl={<RefreshControl refreshing={accounts.isRefetching} onRefresh={() => { accounts.refetch(); direct.refetch(); }} />} testID="social-accounts">
      {social.length ? (
        <InsetGroup header="Connected">
          {social.map((a) => (
            <GroupRow key={a.id} label={appName(a.app, a.appName)} sub={needsReconnect(a) ? `${a.label ? `${a.label}. ` : ""}Sign in needs renewing before you can post.` : a.label}
              testID={`account-${a.app}`}
              right={needsReconnect(a) && canManage
                ? <Button label="Reconnect" variant="secondary" loading={reconnect.isPending && reconnect.variables === a.id} onPress={() => doReconnect(a.id)} testID={`account-reconnect-${a.app}`} style={{ minHeight: 36, paddingHorizontal: 12 }} />
                : <Badge label={needsReconnect(a) ? "Needs reconnect" : a.status === "disabled" ? "Off" : "Connected"} tone={needsReconnect(a) ? "warn" : a.status === "disabled" ? "neutral" : "ok"} />} />
          ))}
        </InsetGroup>
      ) : null}

      {directs.length ? (
        <InsetGroup header="TikTok and Threads" footer="These sign in on multies.si. Connect opens it in your browser.">
          {directs.map((d) => <DirectRow key={d.provider} d={d} canManage={canManage && !!direct.data?.canManage} />)}
        </InsetGroup>
      ) : null}

      {canManage && toConnect.length ? (
        <InsetGroup header="Connect" footer="You sign in with the network in your browser, then come back here.">
          {toConnect.map((app) => (
            <GroupRow key={app} label={appName(app)} sub={SOCIAL_NETWORKS[app]?.target ? `Posts to your ${SOCIAL_NETWORKS[app]!.target!.label.toLowerCase()}s` : "Posts to your profile"}
              testID={`connect-${app}`}
              right={<Button label="Connect" variant="secondary" loading={connect.isPending && connect.variables === app} onPress={() => doConnect(app)} style={{ minHeight: 36, paddingHorizontal: 12 }} />} />
          ))}
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
        ? <Badge label="Connected" tone="ok" />
        : canManage ? <Button label={expired ? "Reconnect" : "Connect"} variant="secondary" onPress={() => { void openWebSocialAccounts(); }} testID={`direct-connect-${d.provider}`} style={{ minHeight: 36, paddingHorizontal: 12 }} />
        : <Badge label={expired ? "Needs reconnect" : "Not connected"} tone={expired ? "warn" : "neutral"} />} />
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  target: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  thumb: { width: "100%", height: 160, borderRadius: radius.md, backgroundColor: colors.elevated },
  smallThumb: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.elevated },
  editor: { minHeight: 140, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong, padding: space.md, color: colors.fg, fontSize: 17, lineHeight: 22 },
  input: { minHeight: 44, backgroundColor: colors.elevated, borderRadius: radius.md, paddingHorizontal: space.md, color: colors.fg, fontSize: 16 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
});
