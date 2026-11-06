import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenHeader, Problem } from "@/components/m3-ui";
import { EmptyState, Icon, Loading, Segmented } from "@/components/ui";
import { Pill } from "@/components/mpar3-ui";
import { colors, font, lh, radius, space, TOUCH } from "@/theme";
import { tr } from "@/i18n";
import { success, tick, warning } from "@/lib/haptics";
import { timeAgo } from "@/lib/format";
import { openAppPath } from "@/lib/web-open";
import { SOURCE_ICON, oneKey, type InboxLane, type InboxView, type OneItem } from "@/lib/mpar3";
import { isOff, useOneAct, useOneInbox } from "@/lib/mpar3-queries";

/**
 * MPAR3: One inbox, as on the web (TD6): mail, chat mentions, tasks and assistant replies in one list, sorted into
 * Important and Noise, with Inbox, Later and Done (GET /api/one-inbox, POST /api/one-inbox/act). Off where the web
 * has it off (404). Opening an item goes to its own screen in the app, or its web page.
 */
export default function OneInbox() {
  const [lane, setLane] = useState<InboxLane>("important");
  const [view, setView] = useState<InboxView>("inbox");
  const q = useOneInbox(lane, view);
  const act = useOneAct();
  const items = q.data?.items ?? [];
  const counts = q.data?.counts;
  const run = async (action: "done" | "undone" | "snooze", it: OneItem) => {
    tick();
    try { await act.mutateAsync({ action, items: [it], ...(action === "snooze" ? { preset: "tomorrow" as const } : {}) }); success(); }
    catch { warning(); }
  };
  const open = (it: OneItem) => { tick(); if (!it.read) act.mutate({ action: "read", items: [it] }); void openAppPath(it.link); };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="one-inbox-screen">
      <ScreenHeader title={tr("m.one.title")} back={tr("common.back")} />
      {q.error && isOff(q.error) ? <EmptyState icon="inbox" title={tr("m.one.off_title")} body={tr("m.one.off_body")} /> : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl, gap: space.md }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
          <Segmented value={lane} label={tr("m.one.lane")} onChange={(v) => { tick(); setLane(v); }} options={[
            { id: "important", label: counts?.importantUnread ? tr("m.one.important_n", { n: counts.importantUnread }) : tr("m.one.important") },
            { id: "noise", label: counts?.noiseUnread ? tr("m.one.noise_n", { n: counts.noiseUnread }) : tr("m.one.noise") },
          ]} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            {(["inbox", "later", "done"] as const).map((v) => <Pill key={v} label={tr(`m.one.view_${v}`)} selected={view === v} onPress={() => { tick(); setView(v); }} testID={`one-view-${v}`} />)}
          </View>
          {q.isLoading ? <Loading label={tr("m.one.loading")} rows={5} /> : q.error && !q.data ? <Problem q={q} what={tr("m.one.title")} testID="one-problem" /> : items.length ? (
            <View style={s.list}>
              {items.map((it, i) => (
                <View key={oneKey(it)} style={[s.row, i > 0 && s.line]} testID={`one-${it.id}`}>
                  <Pressable onPress={() => open(it)} accessibilityRole="button" accessibilityLabel={`${it.title}${it.who ? `, ${it.who}` : ""}${it.read ? "" : `, ${tr("common.unread")}`}`}
                    style={({ pressed }) => [s.main, pressed && { backgroundColor: colors.hover }]}>
                    <View style={s.icon}><Icon name={SOURCE_ICON[it.source] ?? "bell"} size={18} color={colors.brand} /></View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={[s.title, !it.read && { fontWeight: "700" }]} numberOfLines={2}>{it.title}</Text>
                      <Text style={s.sub} numberOfLines={1}>{[it.who, timeAgo(it.at)].filter(Boolean).join(" · ")}</Text>
                      {it.reason ? <Text style={[s.sub, { color: colors.muted }]} numberOfLines={1}>{it.reason}</Text> : null}
                    </View>
                    {!it.read ? <View style={s.dot} accessibilityElementsHidden importantForAccessibility="no" /> : null}
                  </Pressable>
                  {view === "done" ? (
                    <RowBtn icon="undo" label={tr("m.one.undone_named", { name: it.title })} onPress={() => run("undone", it)} testID={`one-undone-${it.id}`} />
                  ) : (
                    <>
                      {view === "inbox" ? <RowBtn icon="snooze" label={tr("m.one.later_named", { name: it.title })} onPress={() => run("snooze", it)} testID={`one-later-${it.id}`} /> : null}
                      <RowBtn icon="check" label={tr("m.one.done_named", { name: it.title })} onPress={() => run("done", it)} testID={`one-done-${it.id}`} />
                    </>
                  )}
                </View>
              ))}
            </View>
          ) : <EmptyState icon="check-circle" title={view === "inbox" ? tr("m.one.empty") : tr("m.one.empty_view")} body={view === "inbox" ? tr("m.one.empty_body") : undefined} />}
        </ScrollView>
      )}
    </View>
  );
}

function RowBtn({ icon, label, onPress, testID }: { icon: "check" | "snooze" | "undo"; label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} style={({ pressed }) => [s.btn, pressed && { backgroundColor: colors.hover }]}>
      <Icon name={icon} size={20} color={colors.muted} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  list: { backgroundColor: colors.surface, borderRadius: 14, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", paddingRight: space.xs },
  line: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  main: { flex: 1, minHeight: 64, flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm, paddingLeft: space.md },
  icon: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" },
  title: { color: colors.fg, fontSize: 15, fontWeight: "500", lineHeight: lh(20) },
  sub: { color: colors.subtle, fontSize: 13, lineHeight: lh(18) },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand },
  btn: { width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
});
