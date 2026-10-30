import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { Banner, Button, EmptyState, Icon, Skeleton } from "@/components/ui";
import { FileChip, RecentStrip, ToolGroup, ToolSearch, openOnWeb } from "@/components/tool-ui";
import { useTools } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { buildEntries, entriesForFile, noRunsLine, recentEntries, resetWhen, runsLeft, runsLeftLabel, searchEntries, sectionsOf, type Entry } from "@/lib/tool-directory";
import { dropCarried, peekCarried, recentKeys, rememberRecent, useSavedRun } from "@/lib/tool-run";
import { mb } from "@/lib/tools";
import { colors, radius, space, TOUCH } from "@/theme";

/**
 * Tools P2 on the phone: the same Tools as the web, laid out for a thumb. Search at the top, the runs left line,
 * Recent, then five sections (Edit PDF, Convert, Secure, Smart, Automate). Phone tools open their own screen; the
 * few that need a big screen open the web page in the in app browser. Every list comes from the server, so a tool
 * switched off on the server never shows here.
 */
export default function Tools() {
  const q = useTools();
  const offline = useOffline();
  const { api, mode } = useSession();
  const [query, setQuery] = useState("");
  const [used, setUsed] = useState<string[]>([]);
  const [carried, setCarried] = useState(() => peekCarried());
  const saved = useSavedRun();

  useEffect(() => { void recentKeys().then(setUsed); }, []);
  // "Use in another tool" comes back here with the result in hand.
  useFocusEffect(useCallback(() => { setCarried(peekCarried()); }, []));
  // A sleeping document engine starts waking as soon as Tools opens (one cheap check; older servers have no route).
  useEffect(() => { if (mode === "live") api.toolsWarm().catch(() => {}); }, [api, mode]);

  const entries = useMemo(() => (q.data ? buildEntries(q.data) : []), [q.data]);
  const shown = useMemo(() => {
    const base = carried ? entriesForFile(entries, carried.name, carried.type) : entries;
    return searchEntries(base, query);
  }, [entries, query, carried]);

  if (q.isPending) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: space.lg, gap: space.lg }} accessibilityLabel="Loading Tools" testID="tools-loading">
        <Skeleton height={44} radius={10} />
        <Skeleton width={180} />
        {[0, 1, 2].map((i) => <Skeleton key={i} height={170} radius={12} />)}
      </View>
    );
  }
  if (q.error) {
    const off = (q.error as { status?: number }).status === 404;
    return off
      ? <EmptyState icon="wrench" title="Tools are off" body="Tools are switched off for this workspace. An admin can turn them on in Settings, General on multies.si." />
      : <EmptyState icon="alert-circle" title="Couldn't load Tools" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  }

  const left = runsLeft(q.data.usage, q.data.limits);
  const open = (e: Entry) => {
    void rememberRecent(e.key).then(setUsed);
    if (e.web) { openOnWeb(e.web); return; }
    router.push({ pathname: "/tool/[op]", params: { op: e.key, ...(carried ? { carried: "1" } : {}) } });
  };
  const resume = () => { if (saved) router.push({ pathname: "/tool/[op]", params: { op: saved.op, resume: "1" } }); };
  const savedName = saved ? entries.find((e) => e.key === saved.op)?.name ?? "A tool" : "";

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingTop: space.sm, paddingBottom: space.xxl * 2, gap: space.xl }} testID="tools"
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />}>
      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        <ToolSearch value={query} onChange={setQuery} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: left.left === 0 ? colors.bad : left.left <= 3 ? colors.warn : colors.ok }} />
          <Text style={{ color: left.left === 0 ? colors.bad : colors.muted, fontSize: 14, fontWeight: "500" }} testID="tools-usage">{runsLeftLabel(left)}</Text>
          <Text style={{ color: colors.subtle, fontSize: 14 }}>{left.left === 0 ? `More ${resetWhen(left)}` : `Files up to ${mb(q.data.limits.maxBytes)}`}</Text>
        </View>
        {left.left === 0 ? <Banner tone="warn" icon="clock" text={noRunsLine(left)} /> : null}
        {offline ? <Banner text="You're offline. Tools need a connection to run." /> : null}
      </View>

      {saved && !carried ? (
        <Pressable onPress={resume} accessibilityRole="button" accessibilityLabel={`${savedName} on ${saved.name}. ${saved.done ? "Ready. Open the result" : "Still working. Open"}`} testID="tools-resume"
          style={({ pressed }) => ({ marginHorizontal: space.lg, flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md, borderRadius: radius.lg, backgroundColor: pressed ? colors.hover : colors.brandSoft })}>
          <Icon name={saved.done ? "check-circle" : "clock"} size={22} color={colors.brand} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }} numberOfLines={1}>{saved.done ? `${savedName} is ready` : `${savedName} is still working`}</Text>
            <Text style={{ color: colors.muted, fontSize: 13 }} numberOfLines={1}>{saved.name}</Text>
          </View>
          <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Open</Text>
        </Pressable>
      ) : null}

      {carried ? (
        <View style={{ marginHorizontal: space.lg, gap: space.sm }} testID="tools-carried">
          <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>Choose a tool for this file</Text>
          <FileChip name={carried.name} size={carried.size} onRemove={() => { dropCarried(); setCarried(null); }} testID="tools-carried-file" />
        </View>
      ) : null}

      {!query && !carried ? <RecentStrip entries={recentEntries(entries, used)} onOpen={open} /> : null}

      {query || carried ? (
        shown.length ? <ToolGroup title={carried && !query ? "Tools that take this file" : "Results"} entries={shown} onOpen={open} testID="tools-results" /> : (
          <View style={{ alignItems: "center", gap: space.sm, paddingHorizontal: space.xl }} testID="tools-no-results">
            <Icon name="search" size={28} color={colors.subtle} />
            <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }}>No tools match</Text>
            <Text style={{ color: colors.subtle, fontSize: 14, textAlign: "center" }}>Try a shorter word, like compress, Word or password.</Text>
            {query ? (
              <Pressable onPress={() => setQuery("")} accessibilityRole="button" style={{ minHeight: TOUCH, justifyContent: "center" }}>
                <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>Clear search</Text>
              </Pressable>
            ) : null}
          </View>
        )
      ) : sectionsOf(entries).map((s) => <ToolGroup key={s.section} title={s.section} entries={s.entries} onOpen={open} testID={`tools-group-${s.section}`} />)}

      <Text style={{ color: colors.subtle, fontSize: 12.5, lineHeight: 18, marginHorizontal: space.lg }}>
        Files run on our document engine and are deleted within an hour. To run a tool on a mail attachment, open the email and tap the attachment.
      </Text>
    </ScrollView>
  );
}
