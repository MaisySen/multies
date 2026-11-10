/**
 * MPAR3: bulk select in the mail list (POST /api/mail/messages/bulk) and a connected mailbox's own folders
 * (GET /api/connections/:id/folders, then the list with ?remote=f:<path>), as on the web.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon, type IconName } from "@/components/ui";
import { Note, Sheet, SheetAction } from "@/components/mpar3-ui";
import { colors, lh, radius, raised, space, TOUCH } from "@/theme";
import { tr } from "@/i18n";
import { success, tick, warning } from "@/lib/haptics";
import { ownFolders, type BulkAction } from "@/lib/mpar3";
import { useBulkMail, useProviderFolders } from "@/lib/mpar3-queries";
import type { MailboxOverview } from "@/api/types";

/** The round tick at the start of a row while selecting. */
export function SelectCheck({ on }: { on: boolean }) {
  return (
    <View style={[s.check, on ? { backgroundColor: colors.brandFill, borderColor: colors.brandFill } : { borderColor: colors.lineStrong }]}>
      {on ? <Icon name="check" size={14} color={colors.brandFg} /> : null}
    </View>
  );
}

/** A mail row while selecting: a tick box (44 pt) beside the row; tapping either ticks it. No control inside another. */
export function SelectableRow({ on, label, onToggle, children, testID }: { on: boolean; label: string; onToggle: () => void; children: React.ReactNode; testID?: string }) {
  return (
    <View style={[s.selRow, on && { backgroundColor: colors.brandSoft }]}>
      <Pressable onPress={() => { tick(); onToggle(); }} role="checkbox" aria-checked={on} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={label} testID={testID}
        style={({ pressed }) => [{ width: TOUCH + space.sm, minHeight: TOUCH, alignItems: "center", justifyContent: "center", paddingLeft: space.sm }, pressed && { opacity: 0.6 }]}>
        <SelectCheck on={on} />
      </Pressable>
      <View style={{ flex: 1 }}>{children}</View>
    </View>
  );
}

function BarButton({ icon, label, onPress, testID, disabled }: { icon: IconName; label: string; onPress: () => void; testID?: string; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} testID={testID}
      style={({ pressed }) => [s.barBtn, (pressed || disabled) && { opacity: disabled ? 0.4 : 0.6 }]}>
      <Icon name={icon} size={20} color={colors.brand} />
      <Text style={s.barText} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

/** The bar at the bottom while selecting: read, archive, move to a folder, delete. */
export function BulkBar({ ids, mailbox, onDone, onUndoable }: { ids: string[]; mailbox: MailboxOverview | undefined; onDone: () => void; onUndoable?: (n: number, action: BulkAction) => void }) {
  const insets = useSafeAreaInsets();
  const bulk = useBulkMail();
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const folders = useProviderFolders(mailbox?.connectionId);
  const own = ownFolders(folders.data);
  const run = async (action: BulkAction, to?: string) => {
    if (!ids.length) return;
    tick(); setErr(null);
    try {
      const r = await bulk.mutateAsync({ ids, action, ...(to ? { to } : {}) });
      // PRIV1b (P67): the server skips mail this person may only read and answers updated 0; say so, keep the selection.
      const n = r?.updated ?? r?.count;
      if (n === 0) { warning(); setMoving(false); return setErr(tr("m.bulk.nothing_changed")); }
      // PRIV1b (P67): some were skipped: offer to undo only what changed and say the rest was not, keeping the bar up.
      if (typeof n === "number" && n < ids.length) { warning(); onUndoable?.(n, action); setMoving(false); return setErr(tr("m.bulk.some_not_changed")); }
      success(); onUndoable?.(typeof n === "number" ? n : ids.length, action); setMoving(false); onDone();
    }
    catch (x) { warning(); setErr((x as Error).message || tr("m.bulk.failed")); }
  };
  const none = !ids.length || bulk.isPending;
  return (
    <>
      <View style={[s.bar, { paddingBottom: insets.bottom + space.sm }]} testID="bulk-bar">
        {err ? <Text style={{ color: colors.bad, fontSize: 13, lineHeight: lh(18), paddingHorizontal: space.lg }} accessibilityRole="alert">{err}</Text> : null}
        <View style={{ flexDirection: "row" }}>
          <BarButton icon="read" label={tr("m.bulk.read")} onPress={() => run("read")} disabled={none} testID="bulk-read" />
          <BarButton icon="unread" label={tr("m.bulk.unread")} onPress={() => run("unread")} disabled={none} testID="bulk-unread" />
          <BarButton icon="archive" label={tr("m.bulk.archive")} onPress={() => run("archive")} disabled={none} testID="bulk-archive" />
          {own.length ? <BarButton icon="move" label={tr("m.bulk.move")} onPress={() => { tick(); setMoving(true); }} disabled={none} testID="bulk-move" /> : null}
          <BarButton icon="trash" label={tr("m.bulk.delete")} onPress={() => run("trash")} disabled={none} testID="bulk-trash" />
        </View>
      </View>
      <Sheet visible={moving} onClose={() => setMoving(false)} title={tr("m.bulk.move_title", { count: ids.length })} subtitle={mailbox?.address} testID="bulk-move-sheet">
        {own.map((f) => <SheetAction key={f.key} icon="move" label={f.name} onPress={() => run("move", f.key)} testID={`move-${f.key}`} />)}
        <Note>{tr("m.bulk.move_note")}</Note>
      </Sheet>
    </>
  );
}

/** The connected mailboxes' own folders: picking one shows its mail. */
export function FolderSheet({ visible, onClose, mailboxes, onPick, current }: {
  visible: boolean; onClose: () => void; mailboxes: MailboxOverview[]; current: string | null; onPick: (mailboxId: string, key: string, name: string) => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title={tr("m.folders.title")} subtitle={tr("m.folders.sub")} testID="folder-sheet">
      {mailboxes.map((m) => <MailboxFolders key={m.id} m={m} current={current} onPick={onPick} multiple={mailboxes.length > 1} />)}
      <Note>{tr("m.folders.note")}</Note>
    </Sheet>
  );
}

function MailboxFolders({ m, current, onPick, multiple }: { m: MailboxOverview; current: string | null; multiple: boolean; onPick: (mailboxId: string, key: string, name: string) => void }) {
  const q = useProviderFolders(m.connectionId);
  const own = ownFolders(q.data);
  return (
    <View style={{ gap: 2 }}>
      {multiple ? <Text style={{ color: colors.muted, fontSize: 13, fontWeight: "600", lineHeight: lh(18) }} numberOfLines={1}>{m.address}</Text> : null}
      {q.isLoading ? <Note>{tr("m.compose3.loading")}</Note> : q.error ? <Note tone="bad">{tr("m.folders.failed")}</Note> : own.length ? own.map((f) => (
        <Pressable key={f.key} onPress={() => { tick(); onPick(m.id, f.key, f.name); }} accessibilityRole="button" accessibilityState={{ selected: current === `${m.id}|${f.key}` }} accessibilityLabel={f.name}
          testID={`folder-${f.key}`} style={({ pressed }) => [s.folder, pressed && { backgroundColor: colors.hover }]}>
          <Icon name="layers" size={20} color={colors.brand} />
          <Text style={{ flex: 1, color: colors.fg, fontSize: 16, lineHeight: lh(21) }} numberOfLines={1}>{f.name}</Text>
          {current === `${m.id}|${f.key}` ? <Icon name="check" size={18} color={colors.brand} /> : null}
        </Pressable>
      )) : <Note>{tr("m.folders.none")}</Note>}
    </View>
  );
}

const s = StyleSheet.create({
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  selRow: { flexDirection: "row", alignItems: "center", gap: 0 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: space.sm, gap: space.xs, ...raised },
  barBtn: { flex: 1, minHeight: 52, minWidth: TOUCH, alignItems: "center", justifyContent: "center", gap: 2, paddingHorizontal: 2 },
  barText: { color: colors.brand, fontSize: 12, fontWeight: "600", lineHeight: lh(16) },
  folder: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.sm, borderRadius: radius.md },
});
