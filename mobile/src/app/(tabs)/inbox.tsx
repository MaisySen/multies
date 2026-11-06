import { useEffect, useMemo, useState } from "react";
import { useCollapse } from "@/components/chrome";
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { NotificationBell } from "@/components/notification-bell";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, Stack } from "expo-router";
import { Banner, Chip, EmptyState, IconButton, Loading, Button, LargeTitle } from "@/components/ui";
import { MessageRow } from "@/components/message-row";
import { SwipeHint, SwipeRow } from "@/components/swipe-row";
import { UndoToast } from "@/components/undo-toast";
import { useMailRowActions } from "@/components/mail-actions";
import { useUndoQueue } from "@/lib/undo-queue";
import { usePrefs } from "@/lib/prefs";
import { openCommandSheet } from "@/lib/command-sheet-store";
import { useAgents, useOverview } from "@/lib/queries";
import { useInboxTabs, useMailMutations, useMessageList, useSnoozed } from "@/lib/mail-queries";
import { activeTab, backLabel, countLabel, tabA11yLabel, type InboxTab } from "@/lib/mail-rules";
import { kv } from "@/lib/kv";
import { tick, warning } from "@/lib/haptics";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import type { ListFolder, MessageSummary } from "@/api/types";
import { colors, radius, space, TOUCH } from "@/theme";
import { tr } from "@/i18n";

type View_ = ListFolder | "snoozed";
const FOLDERS: { id: View_; label: string }[] = [
  { id: "inbox", label: tr("m.inbox.inbox") }, { id: "snoozed", label: tr("m.inbox.snoozed") }, { id: "starred", label: tr("m.inbox.starred") }, { id: "sent", label: tr("m.inbox.sent") }, { id: "archive", label: tr("m.inbox.archive") },
];
const TAB_KEY = "inbox:tab";
let rememberedTab: string | null = null;
const EMPTY_TAB: Record<string, string> = {
  primary: tr("m.inbox.mail_from_people_lands_here"),
  updates: tr("m.inbox.receipts_alerts_and_notices_land_here"),
  promotions: tr("m.inbox.offers_and_newsletters_land_here"),
  important: tr("m.inbox.mail_from_people_you_know_lands_here"),
  other: tr("m.inbox.everything_else_lands_here"),
};

export default function Inbox() {
  const [folder, setFolderRaw] = useState<View_>("inbox");
  const [mailboxId, setMailboxId] = useState<string | undefined>();
  const [label, setLabel] = useState<string | null>(null);
  const [tab, setTabRaw] = useState<string | null>(rememberedTab);
  useEffect(() => { if (rememberedTab === null) void kv().get(TAB_KEY).then((v) => { if (v) { rememberedTab = v; setTabRaw(v); } }).catch(() => {}); }, []);
  const setTab = (id: string) => { tick(); rememberedTab = id; setTabRaw(id); void kv().set(TAB_KEY, id).catch(() => {}); };
  const setFolder = (f: View_) => { setLabel(null); setFolderRaw(f); };
  const listFolder: ListFolder = folder === "snoozed" ? "inbox" : folder;
  // 1.10.7: Inbox tabs (only on Inbox, and not while a label is picked).
  const tabsQ = useInboxTabs(mailboxId, folder === "inbox");
  const tabs: InboxTab[] = tabsQ.data && tabsQ.data.style !== "off" ? tabsQ.data.tabs : [];
  const tabsOn = folder === "inbox" && !label && tabs.length > 0;
  const current = tabsOn ? activeTab(tabs, tab, tabsQ.data?.defaultTab) : "";
  // Wait for the tabs before the list, so it does not flash the whole Inbox first.
  const tabsSettled = folder !== "inbox" || !!label || !tabsQ.isPending;
  const list = useMessageList(listFolder, mailboxId, { split: current || undefined, label: label ?? undefined }, folder !== "snoozed" && tabsSettled);
  const snoozed = useSnoozed("snoozed", mailboxId);
  const returned = useSnoozed("returned", mailboxId, folder === "inbox");
  const backIds = useMemo(() => new Set((returned.data ?? []).map((i) => i.threadId)), [returned.data]);
  const mm = useMailMutations();
  const overview = useOverview();
  const agents = useAgents();
  const offline = useOffline();
  const { mode } = useSession();
  // R31: swipe right to archive, left to snooze, long-press for every action. Swiped rows hide at once with Undo.
  const undo = useUndoQueue();
  const collapse = useCollapse(); // R34: large title folds on scroll
  const actions = useMailRowActions(undo.push, { tabs: tabsQ.data?.style === "off" ? [] : tabsQ.data?.tabs, currentTab: current || undefined });
  const prefs = usePrefs(); // R33: the swipe actions chosen in Settings
  const swipeable = folder === "inbox" || folder === "starred";
  const snoozedRows = useMemo(() => (snoozed.data ?? []).filter((i) => !undo.hidden.has(i.id)), [snoozed.data, undo.hidden]);
  const rows = useMemo(() => (list.data?.pages.flatMap((p) => p.messages) ?? []).filter((m) => !undo.hidden.has(m.id)), [list.data, undo.hidden]);
  const people = overview.data?.filter((m) => m.kind !== "agent") ?? [];
  const unread = (id?: string) => overview.data?.filter((m) => !id || m.id === id).reduce((n, m) => n + (m.folders.inbox?.unread ?? 0), 0) ?? 0;
  const open = (m: MessageSummary) => router.push({ pathname: "/thread/[id]", params: { id: m.id } });
  const backNow = (scheduleId: string) => undo.push(scheduleId, tr("m.inbox.back_in_inbox"), () => mm.unsnooze.mutate(scheduleId, { onError: () => { warning(); } }));
  const tabName = tabs.find((t) => t.id === current)?.name ?? "";

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onSearch={() => router.push("/search")} collapsed={collapse.collapsed} />
      {offline ? <Banner text={tr("m.inbox.you_re_offline_showing_mail_saved_on_this_phone")} /> : null}
      {mode === "sample" ? <Banner tone="brand" icon="compass" text={tr("m.inbox.sample_workspace_nothing_here_is_real_mail")} /> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm }} style={{ flexGrow: 0 }}>
        {FOLDERS.map((f) => <Chip key={f.id} label={f.label} selected={folder === f.id && !label}
          count={f.id === "inbox" ? unread(mailboxId) : f.id === "snoozed" ? snoozed.data?.length : undefined} onPress={() => setFolder(f.id)} />)}
        {people.length > 1 ? <View style={{ width: 1, backgroundColor: colors.line, marginHorizontal: 4 }} /> : null}
        {people.length > 1 ? <Chip label={tr("m.inbox.all_mailboxes")} selected={!mailboxId} onPress={() => setMailboxId(undefined)} /> : null}
        {people.length > 1 ? people.map((m) => <Chip key={m.id} label={m.address.split("@")[0]} selected={mailboxId === m.id} onPress={() => setMailboxId(m.id)} />) : null}
      </ScrollView>
      {label ? <LabelBar label={label} onClear={() => setLabel(null)} /> : null}
      {tabsOn ? <TabBar tabs={tabs} current={current} onPick={setTab} /> : null}
      {folder === "snoozed" ? (
        snoozed.isPending ? <Loading label={tr("m.inbox.loading_snoozed_mail")} /> : snoozed.error && !snoozedRows.length ? (
          <EmptyState icon="alert-circle" title={tr("m.inbox.couldn_t_load_snoozed_mail")} body={tr("m.inbox.check_your_connection_and_try_again")} action={<Button label={tr("m.inbox.try_again")} variant="secondary" onPress={() => snoozed.refetch()} />} />
        ) : (
          <FlatList
            data={snoozedRows}
            {...collapse.scrollProps}
            keyExtractor={(i) => i.id}
            renderItem={({ item }) => item.message ? (
              <SwipeRow testID={`swipe-${item.id}`} right={{ label: tr("m.inbox.back_to_inbox"), icon: "inbox", color: colors.brand, onAction: () => backNow(item.id) }}
                left={{ label: tr("m.inbox.back_to_inbox"), icon: "inbox", color: colors.brand, onAction: () => backNow(item.id) }}>
                <MessageRow m={item.message} agents={agents.data} note={tr("m.inbox.back_dueat", { dueAt: backLabel(item.dueAt) })} noteTone="muted"
                  onLongPress={() => actions.openQuick(item.message!)} onPress={() => open(item.message!)} />
              </SwipeRow>
            ) : null}
            refreshControl={<RefreshControl refreshing={snoozed.isRefetching} onRefresh={() => { snoozed.refetch(); }} tintColor={colors.brand} colors={[colors.brand]} />}
            ListHeaderComponent={snoozedRows.length ? <Text style={{ color: colors.subtle, fontSize: 13, paddingHorizontal: space.lg, paddingVertical: space.sm }}>{tr("m.inbox.swipe_a_mail_to_bring_it_back_now")}</Text> : undefined}
            ListEmptyComponent={<EmptyState icon="alarm-clock" title={tr("m.inbox.nothing_snoozed")} body={tr("m.inbox.snooze_a_mail_from_inbox_and_it_waits_here_until")} />}
            contentContainerStyle={{ paddingBottom: 96 }}
          />
        )
      ) : (<>
      {swipeable && rows.length ? <SwipeHint /> : null}
      {list.isPending ? <Loading label={tr("m.inbox.loading_mail")} /> : list.error && !rows.length ? (
        <EmptyState icon="alert-circle" title={tr("m.inbox.couldn_t_load_your_mail")} body={list.error.message} action={<Button label={tr("m.inbox.try_again")} variant="secondary" onPress={() => list.refetch()} />} />
      ) : (
        <FlatList
          data={rows}
          {...collapse.scrollProps}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => {
            const back = folder === "inbox" && !item.isRead && backIds.has(item.threadId);
            const row = <MessageRow m={item} agents={agents.data} showRecipient={folder === "sent"} onLongPress={() => actions.openMenu(item)}
              note={back ? tr("m.inbox.back_from_snooze") : undefined} noteTone="brand" onLabel={(l) => { tick(); setLabel(l); }}
              onPress={() => open(item)} />;
            return swipeable ? (
              <SwipeRow testID={`swipe-${item.id}`}
                right={actions.swipeFor(item, prefs.mailSwipes.rightShort)} rightLong={actions.swipeFor(item, prefs.mailSwipes.rightLong)}
                left={actions.swipeFor(item, prefs.mailSwipes.leftShort)} leftLong={actions.swipeFor(item, prefs.mailSwipes.leftLong)}>
                {row}
              </SwipeRow>
            ) : row;
          }}
          refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => { list.refetch(); tabsQ.refetch(); returned.refetch(); }} tintColor={colors.brand} colors={[colors.brand]} />}
          onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && list.fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={list.isFetchingNextPage ? <Loading label={tr("m.inbox.loading_more")} /> : undefined}
          ListEmptyComponent={label ? <EmptyState icon="tag" title={tr("m.inbox.no_mail_labelled_label", { label: label })} body={tr("m.inbox.mail_with_this_label_shows_up_here")} />
            : tabsOn ? <EmptyState icon="inbox" title={tr("m.inbox.nothing_in_tabname", { tabName: tabName })} body={EMPTY_TAB[current] ?? tr("m.inbox.mail_you_move_to_this_tab_lands_here")} />
            : <EmptyState icon="inbox" title={folder === "inbox" ? tr("m.inbox.you_re_all_caught_up") : tr("m.inbox.nothing_here")} body={folder === "inbox" ? tr("m.inbox.new_mail_shows_up_here") : undefined} />}
          contentContainerStyle={{ paddingBottom: 96 }}
        />
      )}
      </>)}
      {actions.sheets}
      <UndoToast pending={undo.newest} onUndo={undo.undo} bottom={space.lg + 64} />
      <View style={{ position: "absolute", right: space.lg, bottom: space.lg }}>
        <Button label={tr("m.inbox.compose")} icon="edit-3" onPress={() => router.push("/compose")} testID="compose" style={{ borderRadius: 28, paddingHorizontal: 22, shadowColor: "#000", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 }} />
      </View>
    </View>
  );
}

function Header({ onSearch, collapsed }: { onSearch: () => void; collapsed?: boolean }) {
  const { me } = useSession();
  const insets = useSafeAreaInsets();
  return (
    <LargeTitle title={tr("m.inbox.mail")} subtitle={me?.organization?.name} top={insets.top} collapsed={collapsed} right={(
      <>
        <NotificationBell />
        <IconButton icon="command" label={tr("m.inbox.commands")} onPress={openCommandSheet} testID="open-commands" />
        <IconButton icon="search" label={tr("m.inbox.search")} onPress={onSearch} testID="open-search" />
      </>
    )} />
  );
}

/** 1.10.7: the Inbox tabs, switched by a tap (a sideways swipe on a mail archives or snoozes it). */
export function TabBar({ tabs, current, onPick }: { tabs: InboxTab[]; current: string; onPick: (id: string) => void }) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", paddingHorizontal: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line }} testID="inbox-tabs">
      {tabs.map((t) => {
        const on = t.id === current;
        const n = countLabel(t.unread);
        return (
          <Pressable key={t.id} onPress={() => { if (!on) onPick(t.id); }} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={tabA11yLabel(t)}
            testID={`inbox-tab-${t.id}`} style={({ pressed }) => ({ flex: 1, minHeight: TOUCH, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.7 : 1 })}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}>
              <Text style={{ color: on ? colors.fg : colors.muted, fontWeight: on ? "700" : "600", fontSize: 15, flexShrink: 1 }} numberOfLines={1}>{t.name}</Text>
              {n ? (
                <View style={{ minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: radius.pill, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.brandFill : colors.elevated }}>
                  <Text style={{ color: on ? colors.brandFg : colors.muted, fontSize: 12, fontWeight: "700" }}>{n}</Text>
                </View>
              ) : null}
            </View>
            <View style={{ position: "absolute", left: 10, right: 10, bottom: -1, height: 3, borderRadius: 2, backgroundColor: on ? colors.brand : "transparent" }} />
          </Pressable>
        );
      })}
    </View>
  );
}

function LabelBar({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm }}>
      <Text style={{ color: colors.muted, fontSize: 14 }}>{tr("m.inbox.label")}</Text>
      <Pressable onPress={() => { tick(); onClear(); }} accessibilityRole="button" accessibilityLabel={tr("m.inbox.label_label_show_all_mail", { label: label })} testID="label-filter"
        style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32, paddingHorizontal: space.md, borderRadius: radius.pill, backgroundColor: colors.brandSoft, borderWidth: 1, borderColor: colors.brandLine }}>
        <Text style={{ color: colors.brand, fontWeight: "600", fontSize: 14 }} numberOfLines={1}>{label}</Text>
        <Text style={{ color: colors.brand, fontSize: 16, lineHeight: 18 }} accessibilityElementsHidden importantForAccessibility="no">×</Text>
      </Pressable>
    </View>
  );
}
