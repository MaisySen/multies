import { useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Banner, Button, EmptyState, Icon, IconButton, LargeTitle, Loading, Segmented } from "./ui";
import { ActionSheet, type SheetOption } from "./action-sheet";
import { SwipeRow, type SwipeAction } from "./swipe-row";
import { SnoozeSheet } from "./mail-actions";
import { UndoToast } from "./undo-toast";
import { LegacyNotifications } from "./notifications-legacy";
import { useReadNotifications } from "@/lib/queries";
import { useTriage, useTriageAction } from "@/lib/triage-queries";
import { useBlockedSet } from "@/lib/queries";
import { dropEvent } from "@/lib/moderation";
import { TRIAGE_VIEWS, backLabel, triageMode, type TriageView } from "@/lib/triage";
import { command, commandTitle, createHandlers, type CommandId } from "@/lib/commands";
import { openCommandSheet } from "@/lib/command-sheet-store";
import { snoozeLabel, type SnoozePreset } from "@/lib/snooze";
import { useUndoQueue } from "@/lib/undo-queue";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { tick } from "@/lib/haptics";
import { API_BASE } from "@/config";
import { timeAgo } from "@/lib/format";
import { categoryIcon, notificationTarget } from "@/lib/notifications";
import type { AppNotification } from "@/api/types";
import { colors, font, radius, space } from "@/theme";

/**
 * R31: notifications as a triage inbox. Inbox is what still needs you, Later is snoozed, Done is
 * cleared. Swipe right for Done, left to snooze; long-press for every action; tap to open.
 * A server from before R31 ignores ?view= and the plain list shows instead (no Later or Done).
 */
export function TriageInbox({ tab = false }: { tab?: boolean }) {
  const [view, setView] = useState<TriageView>("inbox");
  const q = useTriage(view);
  const mode = triageMode(q.data, view);
  const act = useTriageAction();
  const read = useReadNotifications();
  const offline = useOffline();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const undo = useUndoQueue();
  const [menuFor, setMenuFor] = useState<AppNotification | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<AppNotification | null>(null);

  const open = (n: AppNotification) => {
    if (!n.read) read.mutate({ ids: [n.id] });
    const target = notificationTarget(n, API_BASE);
    if (target.kind === "route") router.push(target.href as never);
    else if (target.kind === "web") WebBrowser.openBrowserAsync(target.url).catch(() => {});
  };
  const fail = (e: Error) => Alert.alert("That didn't save", e.message);
  const done = (n: AppNotification) => undo.push(n.id, "Marked done", () => act.mutate({ id: n.id, action: "done" }, { onError: fail }));
  const undone = (n: AppNotification) => undo.push(n.id, "Moved back to Inbox", () => act.mutate({ id: n.id, action: "undone" }, { onError: fail }));
  const snooze = (n: AppNotification, preset: SnoozePreset) =>
    undo.push(n.id, `Snoozed until ${snoozeLabel(preset).toLowerCase()}`, () => act.mutate({ id: n.id, action: "snooze", preset }, { onError: fail }));

  const handlersFor = (n: AppNotification) => createHandlers({
    navigate: (href) => router.push(href as never),
    openWeb: () => {},
    triage: (a) => (a === "open" ? open(n) : a === "done" ? done(n) : undone(n)),
    pickSnooze: () => setSnoozeFor(n),
  });

  // R35: activity from people you blocked (a mention, a reply) is left out on the phone too.
  const blocked = useBlockedSet();
  const items = useMemo(() => (mode.kind === "triage" ? mode.items.filter((n) => !undo.hidden.has(n.id) && !(n.actor && n.actor.type !== "agent" && dropEvent({ author: n.actor }, blocked))) : []), [mode, undo.hidden, blocked]);

  const header = tab ? (
    <LargeTitle title="Activity" top={insets.top} right={(
      <>
        <IconButton icon="command" label="Commands" onPress={openCommandSheet} testID="open-commands" />
        <IconButton icon="sliders" label="Notification settings" onPress={() => router.push("/notification-settings")} />
      </>
    )} />
  ) : <Stack.Screen options={{ title: "Notifications" }} />;

  if (mode.kind === "legacy") {
    return tab ? <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<LegacyNotifications /></View> : <LegacyNotifications />;
  }

  const counts = mode.kind === "triage" ? mode.counts : { inbox: 0, later: 0, done: 0 };
  const markAllDone = () => {
    const ids = items.map((n) => n.id);
    if (!ids.length) return;
    Alert.alert(`Mark ${ids.length} done?`, "They move to Done. You can move any back.", [
      { text: "Cancel", style: "cancel" },
      { text: "Mark done", onPress: () => { tick(); api.notificationsDone(ids).catch(fail).finally(() => q.refetch()); } },
    ]);
  };

  const swipes = (n: AppNotification): { right?: SwipeAction; left?: SwipeAction } => {
    if (view === "done") return { right: { label: commandTitle("triage-undone"), icon: "inbox", color: colors.brand, onAction: () => undone(n) } };
    const right: SwipeAction = { label: "Done", icon: "check", color: colors.ok, onAction: () => done(n) };
    if (view === "later") return { right, left: { label: "Inbox", icon: "inbox", color: colors.brand, onAction: () => undone(n) } };
    return { right, left: { label: command("triage-snooze").title, icon: "alarm-clock", color: colors.warn, onAction: () => setSnoozeFor(n) } };
  };

  const menuOptions = (n: AppNotification): SheetOption[] => {
    const ids: CommandId[] = view === "inbox" ? ["triage-open", "triage-done", "triage-snooze"] : view === "later" ? ["triage-open", "triage-done", "triage-undone", "triage-snooze"] : ["triage-open", "triage-undone"];
    return ids.map((id) => ({ id, label: commandTitle(id), icon: command(id).icon }));
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="triage">
      {header}
      {offline ? <Banner text="You're offline. These are the notifications saved on this phone." /> : null}
      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm, gap: space.sm }}>
        <Segmented label="Notification view" value={view} onChange={(v) => { tick(); setView(v); }}
          options={TRIAGE_VIEWS.map((v) => ({ id: v.id, label: counts[v.id] ? `${v.label} ${counts[v.id]}` : v.label }))} />
        {view === "inbox" && items.length ? (
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={font.small}>Swipe right for done, left to snooze</Text>
            <Button label="Mark all done" variant="ghost" icon="check" onPress={markAllDone} testID="mark-all-done" style={{ minHeight: 36 }} />
          </View>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxl * 3 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.brand} />}>
        {mode.kind === "loading" && q.isPending ? <Loading /> : q.error && !items.length ? (
          <EmptyState icon="alert-circle" title="Couldn't load notifications" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />
        ) : items.length ? items.map((n) => (
          <SwipeRow key={n.id} {...swipes(n)} testID={`swipe-${n.id}`}>
            <TriageRow n={n} showBack={view === "later"} onPress={() => open(n)} onLongPress={() => { tick(); setMenuFor(n); }} />
          </SwipeRow>
        )) : view === "inbox" ? (
          <EmptyState icon="check-circle" title="You're all caught up" body="Mentions, assignments and review requests land here."
            action={<Button label="View done" variant="secondary" icon="check" onPress={() => setView("done")} testID="view-done" />} />
        ) : view === "later" ? (
          <EmptyState icon="alarm-clock" title="Nothing snoozed" body="Swipe left on a notification to bring it back later." />
        ) : (
          <EmptyState icon="check" title="Nothing done yet" body="Swipe right on a notification when you've dealt with it." />
        )}
        {!tab ? (
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.lg }}>
            <Button label="Notification settings" icon="sliders" variant="secondary" onPress={() => router.push("/notification-settings")} testID="open-notification-settings" />
          </View>
        ) : null}
      </ScrollView>
      <UndoToast pending={undo.newest} onUndo={undo.undo} />
      {menuFor ? (
        <ActionSheet visible title={menuFor.title} subtitle={timeAgo(menuFor.createdAt)} options={menuOptions(menuFor)} testID="triage-actions"
          onSelect={(id) => { const n = menuFor; setMenuFor(null); handlersFor(n)[id as CommandId]({ notificationId: n.id }); }} onClose={() => setMenuFor(null)} />
      ) : null}
      <SnoozeSheet visible={!!snoozeFor} title={snoozeFor?.title ?? ""} onClose={() => setSnoozeFor(null)}
        onPick={(p) => { const n = snoozeFor; setSnoozeFor(null); if (n) snooze(n, p); }} />
    </View>
  );
}

function TriageRow({ n, showBack, onPress, onLongPress }: { n: AppNotification; showBack: boolean; onPress: () => void; onLongPress: () => void }) {
  const later = showBack && n.snoozedUntil ? backLabel(n.snoozedUntil) : null;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} accessibilityRole="button"
      accessibilityLabel={`${n.read ? "" : "Unread. "}${n.title}, ${timeAgo(n.createdAt)}`} accessibilityHint="Opens it. Long press for more actions." testID={`notification-${n.id}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 64, paddingHorizontal: space.lg, paddingVertical: space.sm,
        backgroundColor: pressed ? colors.hover : n.read ? colors.bg : colors.surface, borderBottomWidth: 1, borderBottomColor: colors.line })}>
      <View style={{ width: 8, alignItems: "center" }}>
        {n.read ? null : <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand }} testID={`unread-dot-${n.id}`} />}
      </View>
      <View style={{ width: 36, height: 36, borderRadius: radius.md, backgroundColor: n.read ? colors.elevated : colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
        <Icon name={categoryIcon(n.category)} size={17} color={n.read ? colors.muted : colors.brand} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: n.read ? colors.muted : colors.fg, fontSize: 15, fontWeight: n.read ? "400" : "600" }} numberOfLines={2}>{n.title}</Text>
        <Text style={font.tiny}>{later ?? timeAgo(n.createdAt)}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={colors.subtle} />
    </Pressable>
  );
}
