import { useState } from "react";
import { Alert, Pressable, Switch, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { ActionSheet, type SheetOption } from "./action-sheet";
import { keys, useMessageAction } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { useLabels, useMailMutations } from "@/lib/mail-queries";
import { LABEL_MAX, type InboxTab } from "@/lib/mail-rules";
import { copyToClipboard, firstLink, openQuickActions, shareContent, showQuickToast, translateText } from "@/lib/quick-actions";
import { bodyText } from "@/lib/mail-body";
import { displayName } from "@/lib/format";
import { useMailSnooze } from "@/lib/triage-queries";
import { MAIL_MENU, command, commandTitle, createHandlers, type CommandId } from "@/lib/commands";
import { SNOOZE_PRESETS, snoozeLabel, type SnoozePreset } from "@/lib/snooze";
import { success, tick, warning } from "@/lib/haptics";
import type { MailSwipe } from "@/lib/prefs";
import type { SwipeAction } from "./swipe-row";
import { colors, radius, space, TOUCH } from "@/theme";
import type { MessageSummary } from "@/api/types";

/** The snooze picker on its own (swipe left on a mail row or a notification). */
export function SnoozeSheet({ visible, title, onPick, onClose }: { visible: boolean; title: string; onPick: (p: SnoozePreset) => void; onClose: () => void }) {
  const options: SheetOption[] = SNOOZE_PRESETS.map((p) => ({ id: p.id, label: p.label, hint: p.hint, icon: "alarm-clock" }));
  return <ActionSheet visible={visible} title="Snooze until" subtitle={title} options={options} onSelect={(id) => onPick(id as SnoozePreset)} onClose={onClose} testID="snooze-sheet" />;
}

/**
 * R31: what a mail row can do, from the registry: Reply, Archive, Snooze, Star, Mark read or unread,
 * Move to trash. `hideRow` lets the list take the row away at once with an Undo toast; without it
 * the action runs straight away.
 */
export function useMailRowActions(hideRow?: (id: string, label: string, run: () => void) => void, opts: { tabs?: InboxTab[]; currentTab?: string } = {}) {
  const act = useMessageAction();
  const snooze = useMailSnooze();
  const mm = useMailMutations();
  const { api } = useSession();
  const qc = useQueryClient();
  const [menuFor, setMenuFor] = useState<MessageSummary | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<MessageSummary | null>(null);
  const [tabFor, setTabFor] = useState<MessageSummary | null>(null);
  const [labelFor, setLabelFor] = useState<MessageSummary | null>(null);
  const tabs = opts.tabs ?? [];

  /** The whole text of the mail (the row has a preview only): from the saved thread, else read once. */
  const fullText = async (m: MessageSummary) => {
    try {
      const t = await qc.fetchQuery({ queryKey: keys.thread(m.id), queryFn: () => api.message(m.id), staleTime: 60_000 });
      const msg = t.thread.find((x) => x.id === m.id) ?? t.message;
      return { text: [m.subject, bodyText(msg)].filter(Boolean).join("\n\n"), link: firstLink(bodyText(msg)) };
    } catch {
      return { text: [m.subject, m.snippet].filter(Boolean).join("\n\n"), link: firstLink(m.snippet) };
    }
  };
  const quick = async (m: MessageSummary, what: "copy" | "link" | "share" | "translate") => {
    const { text, link } = await fullText(m);
    if (what === "copy") await copyToClipboard(text);
    else if (what === "link") { if (link) await copyToClipboard(link, "Link copied"); else showQuickToast("No link in this mail", "bad"); }
    else if (what === "share") await shareContent({ text, title: m.subject });
    else await translateText(text);
  };
  const moveToTab = (m: MessageSummary, tab: string, sender: boolean) => {
    const name = tabs.find((t) => t.id === tab)?.name ?? tab;
    const go = () => mm.teach.mutate({ messageId: m.id, tab, sender }, { onSuccess: () => success(), onError: fail("move it") });
    // Leaving the open tab: the row goes at once with Undo (the move is made when the Undo time is up).
    if (hideRow && opts.currentTab && tab !== opts.currentTab) hideRow(m.id, `Moved to ${name}`, go);
    else { go(); showQuickToast(`Moved to ${name}`); }
  };

  const fail = (what: string) => (e: Error) => { warning(); Alert.alert(`Couldn't ${what}`, e.message); };
  const run = (m: MessageSummary, action: "archive" | "star" | "unstar" | "read" | "unread" | "trash") => {
    const go = () => act.mutate({ id: m.id, action }, { onError: fail(action === "trash" ? "move it to trash" : action === "read" || action === "unread" ? "change it" : action) });
    if ((action === "archive" || action === "trash") && hideRow) hideRow(m.id, action === "archive" ? "Archived" : "Moved to trash", go);
    else go();
  };
  const doSnooze = (m: MessageSummary, preset: SnoozePreset) => {
    const go = () => snooze.mutate({ id: m.id, preset }, { onError: fail("snooze it") });
    if (hideRow) hideRow(m.id, `Snoozed until ${snoozeLabel(preset).toLowerCase()}`, go); else go();
  };

  const handlersFor = (m: MessageSummary) => createHandlers({
    navigate: (href) => router.push(href as never),
    openWeb: () => {},
    mail: (action) => run(m, action),
    pickSnooze: () => setSnoozeFor(m),
  });

  const sheets = (
    <>
      {menuFor ? (
        <ActionSheet visible title={menuFor.subject || "(no subject)"} subtitle={menuFor.from.name || menuFor.from.address} testID="mail-actions"
          options={menuOptions(menuFor, tabs.length > 0)}
          onSelect={(id) => {
            const m = menuFor; setMenuFor(null); tick();
            if (id === "move-tab") setTabFor(m);
            else if (id === "labels") setLabelFor(m);
            else if (id === "copy-text") void quick(m, "copy");
            else if (id === "copy-link") void quick(m, "link");
            else if (id === "share") void quick(m, "share");
            else if (id === "translate") void quick(m, "translate");
            else handlersFor(m)[id as CommandId]({ messageId: m.id, starred: m.isStarred, read: m.isRead });
          }}
          onClose={() => setMenuFor(null)} />
      ) : null}
      {tabFor ? <MoveToTabSheet m={tabFor} tabs={tabs} current={opts.currentTab} onClose={() => setTabFor(null)}
        onPick={(tab, sender) => { const m = tabFor; setTabFor(null); moveToTab(m, tab, sender); }} /> : null}
      {labelFor ? <LabelSheet m={labelFor} onClose={() => setLabelFor(null)} /> : null}
      <SnoozeSheet visible={!!snoozeFor} title={snoozeFor?.subject || "(no subject)"} onClose={() => setSnoozeFor(null)}
        onPick={(p) => { const m = snoozeFor; setSnoozeFor(null); if (m) doSnooze(m, p); }} />
    </>
  );

  return {
    openMenu: (m: MessageSummary) => { tick(); setMenuFor(m); void qc.prefetchQuery({ queryKey: keys.thread(m.id), queryFn: () => api.message(m.id), staleTime: 60_000 }); },
    /** Snoozed list: the long press offers the small things only. */
    openQuick: (m: MessageSummary) => openQuickActions({ title: m.subject || "(no subject)", subtitle: displayName(m.from), text: [m.subject, m.snippet].filter(Boolean).join("\n\n"), link: firstLink(m.snippet) }),
    archive: (m: MessageSummary) => run(m, "archive"),
    pickSnooze: (m: MessageSummary) => setSnoozeFor(m),
    /** R33: the swipe action the person chose in Settings for this slot, or none. */
    swipeFor: (m: MessageSummary, choice: MailSwipe): SwipeAction | undefined => {
      switch (choice) {
        case "archive": return { label: "Archive", icon: "archive", color: colors.ok, onAction: () => run(m, "archive") };
        case "snooze": return { label: "Snooze", icon: "alarm-clock", color: colors.warn, onAction: () => setSnoozeFor(m) };
        case "read": return { label: m.isRead ? "Mark unread" : "Mark read", icon: m.isRead ? "mail" : "mail-open", color: colors.brand, onAction: () => run(m, m.isRead ? "unread" : "read") };
        case "delete": return { label: "Delete", icon: "trash-2", color: colors.bad, onAction: () => run(m, "trash") };
        default: return undefined;
      }
    },
    sheets,
  };
}

/** The long press menu of a mail row: the mail actions, then sorting, then the small things, with Trash last. */
export function menuOptions(m: MessageSummary, withTabs: boolean): SheetOption[] {
  const reg = (id: CommandId): SheetOption => ({ id, label: commandTitle(id, { starred: m.isStarred, read: m.isRead }), icon: command(id).icon, destructive: command(id).destructive });
  const head = MAIL_MENU.filter((id) => id !== "mail-trash").map(reg);
  return [
    ...head,
    ...(withTabs ? [{ id: "move-tab", label: "Move to a tab", icon: "layers" } as SheetOption] : []),
    { id: "labels", label: m.labels?.length ? "Labels" : "Add a label", icon: "tag", hint: m.labels?.length ? m.labels.join(", ") : undefined },
    { id: "copy-text", label: "Copy text", icon: "copy" },
    { id: "copy-link", label: "Copy link", icon: "link" },
    { id: "share", label: "Share", icon: "send" },
    { id: "translate", label: "Translate", icon: "globe" },
    ...(MAIL_MENU.includes("mail-trash") ? [reg("mail-trash")] : []),
  ];
}

/** Move to a tab: the tabs with a tick on the current one, and "Do this for all mail from <sender>" (on, as on the web). */
export function MoveToTabSheet({ m, tabs, current, onPick, onClose }: { m: MessageSummary; tabs: InboxTab[]; current?: string; onPick: (tab: string, sender: boolean) => void; onClose: () => void }) {
  const [sender, setSender] = useState(true);
  const who = m.from.name || m.from.address;
  return (
    <ActionSheet visible title="Move to a tab" subtitle={m.subject || "(no subject)"} testID="move-tab-sheet" onClose={onClose}
      options={tabs.map((t) => ({ id: t.id, label: t.name, icon: "layers", selected: t.id === current }))}
      onSelect={(id) => { tick(); onPick(id, sender); }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, minHeight: TOUCH + 6, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        <Text style={{ flex: 1, color: colors.fg, fontSize: 15 }} numberOfLines={2}>Do this for all mail from {who}</Text>
        <Switch value={sender} onValueChange={(v) => { tick(); setSender(v); }} accessibilityLabel={`Do this for all mail from ${who}`} testID="move-tab-sender"
          trackColor={{ true: colors.brandFill, false: colors.elevated }} />
      </View>
    </ActionSheet>
  );
}

/** Labels on a mail: tap one to take it off, pick a used one or type a new one. */
export function LabelSheet({ m, onClose }: { m: MessageSummary; onClose: () => void }) {
  const mm = useMailMutations();
  const all = useLabels();
  const [mine, setMine] = useState<string[]>(m.labels ?? []);
  const [draft, setDraft] = useState("");
  const has = (l: string) => mine.some((x) => x.toLowerCase() === l.toLowerCase());
  const toggle = (l: string) => {
    tick();
    const on = has(l);
    setMine(on ? mine.filter((x) => x.toLowerCase() !== l.toLowerCase()) : [...mine, l]);
    (on ? mm.removeLabel : mm.addLabel).mutate({ threadId: m.threadId, label: l }, {
      onError: (e) => { warning(); setMine(m.labels ?? []); Alert.alert("Couldn't change the label", e.message); },
    });
  };
  const add = () => { const l = draft.trim().slice(0, LABEL_MAX); if (!l || /^tab:/i.test(l)) return; setDraft(""); if (!has(l)) toggle(l); };
  const known = [...new Set([...(all.data ?? []).map((x) => x.label), ...mine])].sort((a, b) => a.localeCompare(b));
  return (
    <ActionSheet visible title="Labels" subtitle={m.subject || "(no subject)"} testID="label-sheet" onClose={onClose}
      options={known.map((l) => ({ id: l, label: l, icon: "tag", selected: has(l) }))} onSelect={toggle}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <TextInput value={draft} onChangeText={setDraft} placeholder="New label" placeholderTextColor={colors.subtle} maxLength={LABEL_MAX}
          onSubmitEditing={add} returnKeyType="done" accessibilityLabel="New label" testID="label-new"
          style={{ flex: 1, minHeight: TOUCH, borderRadius: radius.md, backgroundColor: colors.elevated, color: colors.fg, paddingHorizontal: space.md, fontSize: 16 }} />
        <Pressable onPress={add} accessibilityRole="button" accessibilityLabel="Add label" testID="label-add" disabled={!draft.trim()}
          style={{ minHeight: TOUCH, paddingHorizontal: space.lg, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: draft.trim() ? colors.brandFill : colors.elevated }}>
          <Text style={{ color: draft.trim() ? colors.brandFg : colors.subtle, fontWeight: "600", fontSize: 15 }}>Add</Text>
        </Pressable>
      </View>
    </ActionSheet>
  );
}
