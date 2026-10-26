import { useState } from "react";
import { Alert } from "react-native";
import { router } from "expo-router";
import { ActionSheet, type SheetOption } from "./action-sheet";
import { useMessageAction } from "@/lib/queries";
import { useMailSnooze } from "@/lib/triage-queries";
import { MAIL_MENU, command, commandTitle, createHandlers, type CommandId } from "@/lib/commands";
import { SNOOZE_PRESETS, snoozeLabel, type SnoozePreset } from "@/lib/snooze";
import { tick } from "@/lib/haptics";
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
export function useMailRowActions(hideRow?: (id: string, label: string, run: () => void) => void) {
  const act = useMessageAction();
  const snooze = useMailSnooze();
  const [menuFor, setMenuFor] = useState<MessageSummary | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<MessageSummary | null>(null);

  const fail = (what: string) => (e: Error) => Alert.alert(`Couldn't ${what}`, e.message);
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
          options={MAIL_MENU.map((id): SheetOption => ({ id, label: commandTitle(id, { starred: menuFor.isStarred, read: menuFor.isRead }), icon: command(id).icon, destructive: command(id).destructive }))}
          onSelect={(id) => { const m = menuFor; setMenuFor(null); tick(); handlersFor(m)[id as CommandId]({ messageId: m.id, starred: m.isStarred, read: m.isRead }); }}
          onClose={() => setMenuFor(null)} />
      ) : null}
      <SnoozeSheet visible={!!snoozeFor} title={snoozeFor?.subject || "(no subject)"} onClose={() => setSnoozeFor(null)}
        onPick={(p) => { const m = snoozeFor; setSnoozeFor(null); if (m) doSnooze(m, p); }} />
    </>
  );

  return {
    openMenu: (m: MessageSummary) => { tick(); setMenuFor(m); },
    archive: (m: MessageSummary) => run(m, "archive"),
    pickSnooze: (m: MessageSummary) => setSnoozeFor(m),
    sheets,
  };
}
