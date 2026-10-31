import { useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { useNow } from "@/lib/use-now";
import { NetworkMark, plainError } from "@/components/social";
import { ago } from "@/lib/social";
import {
  INBOX_FILTERS, INBOX_KIND_LABEL, assigneeLine, emptyInbox, filterCount, replyWindow, whoWrote,
  type InboxFilter, type InboxItemView, type InboxListResponse,
} from "@/lib/social-inbox";
import { useSocialInbox } from "@/lib/social-queries";
import { tick } from "@/lib/haptics";
import { colors, font, radius, space } from "@/theme";

/** 1.10.8: the filters with their counts, pinned under the Social parts like the Posts filters. */
export function InboxFilters({ value, onChange, counts }: { value: InboxFilter; onChange: (f: InboxFilter) => void; counts?: InboxListResponse["counts"] }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, flexGrow: 1 }} accessibilityLabel="Filter conversations" testID="inbox-filters">
      {INBOX_FILTERS.map((f) => {
        const n = filterCount(counts, f.id);
        const on = value === f.id;
        return (
          <Pressable key={f.id} onPress={() => { tick(); onChange(f.id); }} accessibilityRole="button" accessibilityState={{ selected: on }}
            accessibilityLabel={n === undefined ? f.label : `${f.label}, ${n}`} testID={`inbox-filter-${f.id}`}
            style={[styles.filter, on && { backgroundColor: colors.brandSoft, borderColor: colors.brandLine }]}>
            <Text style={{ color: on ? colors.brandHover : colors.muted, fontWeight: "600", fontSize: 13 }} numberOfLines={1}>{f.label}</Text>
            {n !== undefined ? <Text style={{ color: on ? colors.brand : colors.subtle, fontSize: 12, fontVariant: ["tabular-nums"] }}>{n}</Text> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function InboxSkeletons() {
  return (
    <View style={{ padding: space.lg, gap: space.md }} accessibilityLabel="Loading conversations" accessible testID="inbox-loading">
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={[styles.row, { gap: space.md }]}>
          <Skeleton width={32} height={32} radius={16} />
          <View style={{ flex: 1, gap: 8 }}><Skeleton width="50%" /><Skeleton width="90%" /></View>
        </View>
      ))}
    </View>
  );
}

/** The Inbox part of Social: comments, messages and mentions from every account in one list. */
export function InboxTab({ filter, onAccounts }: { filter: InboxFilter; onAccounts: () => void }) {
  const q = useSocialInbox(filter);
  const insets = useSafeAreaInsets();
  const [pulling, setPulling] = useState(false);
  const now = useNow();
  const refresh = async () => { setPulling(true); try { await q.refetch(); } finally { setPulling(false); } };
  if (q.isPending) return <InboxSkeletons />;
  if (q.error && !q.data) {
    return (
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingBottom: insets.bottom + space.xl }} contentInsetAdjustmentBehavior="never"
        refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.brand} />} testID="inbox-error">
        <EmptyState icon="alert-circle" title="Couldn't load the inbox" body={plainError(q.error)} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} testID="inbox-try-again" />} />
      </ScrollView>
    );
  }
  const d = q.data!;
  const broken = d.sources.filter((s) => s.state === "error");
  const empty = emptyInbox(filter, d.sources);
  return (
    <FlatList
      data={d.items}
      keyExtractor={(x) => x.id}
      renderItem={({ item }) => <InboxRow item={item} me={d.me} now={now} />}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm, paddingBottom: insets.bottom + space.xxl, flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={pulling} onRefresh={refresh} tintColor={colors.brand} />}
      ListHeaderComponent={broken.length ? (
        <View style={[styles.broken]} testID="inbox-broken">
          <Text style={[font.small, { color: colors.fg, flex: 1 }]}>
            {broken.length === 1 ? `${broken[0]!.label} needs signing in again. New messages from it wait until then.` : `${broken.length} accounts need signing in again. New messages from them wait until then.`}
          </Text>
          <Button label="Accounts" variant="secondary" onPress={onAccounts} testID="inbox-open-accounts" style={{ minHeight: 44, paddingHorizontal: 12 }} />
        </View>
      ) : undefined}
      ListEmptyComponent={<EmptyState icon="inbox" title={empty.title} body={empty.body} />}
      testID="inbox-list"
    />
  );
}

export function InboxRow({ item, me, now }: { item: InboxItemView; me: string; now: number }) {
  const who = whoWrote(item);
  const w = item.status === "open" ? replyWindow(item.app, item.kind, item.lastInboundAt, now) : { state: "none" as const };
  const kind = INBOX_KIND_LABEL[item.kind];
  const when = ago(item.receivedAt, now);
  const assignee = item.assigneeId ? assigneeLine(item, me) : null;
  const label = [`${kind} from ${who}`, `on ${item.accountLabel}`, when, item.text, assignee ? `Assigned to ${assignee}` : null, w.state !== "none" ? w.text.split(".")[0] : null, item.repliedAt ? "Replied" : null].filter(Boolean).join(", ");
  return (
    <Pressable onPress={() => router.push({ pathname: "/social-inbox/[id]", params: { id: item.id } })} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.hover }]} testID={`inbox-row-${item.id}`}>
      <NetworkMark app={item.app} size={32} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={[font.headline, { flex: 1 }]} numberOfLines={1}>{who}</Text>
          <Text style={[font.tiny, { color: colors.subtle }]}>{when}</Text>
        </View>
        <Text style={[font.small, { color: colors.muted }]} numberOfLines={1}>{kind} on {item.accountLabel}</Text>
        <Text style={[font.body, { color: colors.fg }]} numberOfLines={2}>{item.text}</Text>
        {assignee || w.state !== "none" || item.repliedAt ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
            {assignee ? <Badge label={assignee} tone="neutral" icon="user" /> : null}
            {w.state === "open" ? <Badge label={w.text} tone={w.soon ? "warn" : "neutral"} icon="clock" /> : null}
            {w.state === "closed" ? <Badge label="Reply window closed" tone="bad" icon="clock" /> : null}
            {item.repliedAt ? <Badge label="Replied" tone="ok" icon="check" /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  filter: { flexDirection: "row", alignItems: "center", gap: 5, minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  row: { flexDirection: "row", gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: colors.surface, minHeight: 64 },
  broken: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, marginBottom: space.sm, borderRadius: radius.lg, backgroundColor: colors.warnSoft },
});
