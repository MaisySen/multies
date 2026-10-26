import { useState } from "react";
import { Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./ui";
import { ActionSheet } from "./action-sheet";
import { useReduceMotion } from "@/lib/motion";
import { useBlockPerson, useBlocks, useReport, useUnblockPerson } from "@/lib/queries";
import {
  blockConfirm, blockedIds, HIDDEN_ROW, NOTE_MAX, REPORT_REASONS, REPORT_THANKS, reportErrorText, userIdOf,
  type ReportContext, type ReportReason,
} from "@/lib/moderation";
import { colors, radius, space, TOUCH } from "@/theme";

/** What a report is about: a message (with its author) or a person. */
export interface ReportTarget {
  targetType: "message" | "user"; messageId?: string; /** Chat id or user id of the person; either form works. */ userId: string; name: string; context: ReportContext;
  /** Whether the "Also block" button may show (never for agents or yourself). */ canBlock?: boolean;
}

/**
 * The block confirm: a native alert naming the person, destructive style. The web preview has no
 * native alert with buttons, so it uses the browser's confirm.
 */
export function confirmBlock(name: string, onConfirm: () => void) {
  const c = blockConfirm(name);
  if (Platform.OS === "web") {
    const ok = typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(`${c.title}\n\n${c.body}`) : false;
    if (ok) onConfirm();
    return;
  }
  Alert.alert(c.title, c.body, [{ text: "Cancel", style: "cancel" }, { text: c.action, style: "destructive", onPress: onConfirm }]);
}

/** The one quiet row in a conversation that had messages from people you blocked. No count, by design. */
export function HiddenMessagesRow() {
  return (
    <View testID="blocked-hidden-row" accessibilityRole="text"
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: space.sm, paddingHorizontal: space.lg }}>
      <Icon name="eye" size={14} color={colors.subtle} />
      <Text style={{ color: colors.subtle, fontSize: 13 }}>{HIDDEN_ROW}</Text>
    </View>
  );
}

/**
 * Report, block and unblock for one screen: the report sheet, the block confirm and the blocked set.
 * Every chat surface (channel, thread, DM, meeting chat) uses this one hook so they behave the same.
 */
export function useSafety() {
  const blocks = useBlocks();
  const block = useBlockPerson();
  const unblock = useUnblockPerson();
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const blocked = blockedIds(blocks.data?.blocks);
  const isBlocked = (id: string) => blocked.has(userIdOf(id));
  const askBlock = (p: { userId: string; name: string }, after?: () => void) =>
    confirmBlock(p.name, () => { block.mutate({ userId: userIdOf(p.userId), name: p.name }); after?.(); });
  const doUnblock = (id: string) => unblock.mutate(userIdOf(id));
  const ui = (
    <ReportSheet target={target} onClose={() => setTarget(null)} alreadyBlocked={target ? isBlocked(target.userId) : false}
      onAlsoBlock={(t) => askBlock({ userId: t.userId, name: t.name }, () => setTarget(null))} />
  );
  return { blocked, isBlocked, startReport: setTarget, askBlock, unblock: doUnblock, ui, missing: !!blocks.data?.missing };
}

/**
 * The report sheet: reasons as a grouped inset list with check rows, an optional note, Send. Then the
 * thanks line, with "Also block" when the person can be blocked and is not yet.
 */
export function ReportSheet({ target, onClose, onAlsoBlock, alreadyBlocked }: {
  target: ReportTarget | null; onClose: () => void; onAlsoBlock: (t: ReportTarget) => void; alreadyBlocked?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const report = useReport();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setReason(null); setNote(""); setSent(false); setError(null); report.reset(); onClose(); };
  if (!target) return null;
  const send = () => {
    if (!reason || report.isPending) return;
    setError(null);
    report.mutate({
      targetType: target.targetType, messageId: target.messageId, userId: userIdOf(target.userId), context: target.context, reason, note,
    }, { onSuccess: () => setSent(true), onError: (e) => setError(reportErrorText(e)) });
  };
  const title = target.targetType === "message" ? "Report message" : `Report ${target.name}`;
  return (
    <Modal visible transparent animationType={reduce ? "none" : "slide"} onRequestClose={close} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.35)" }} onPress={close} accessibilityLabel="Close" accessibilityRole="button" />
      <View testID="report-sheet" accessibilityViewIsModal
        style={{ backgroundColor: colors.bg, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, paddingBottom: insets.bottom + space.md, maxHeight: "88%" }}>
        <View style={{ alignItems: "center", paddingTop: space.sm }}><View style={{ width: 36, height: 5, borderRadius: 3, backgroundColor: colors.line }} /></View>
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm }}>
          <Pressable onPress={close} accessibilityRole="button" accessibilityLabel={sent ? "Done" : "Cancel"} testID="report-cancel" hitSlop={10} style={{ minWidth: 64, minHeight: TOUCH, justifyContent: "center" }}>
            <Text style={{ color: colors.brand, fontSize: 17 }}>{sent ? "" : "Cancel"}</Text>
          </Pressable>
          <Text style={{ flex: 1, textAlign: "center", color: colors.fg, fontSize: 17, fontWeight: "600" }} accessibilityRole="header" numberOfLines={1}>{sent ? "Report sent" : title}</Text>
          {sent ? (
            <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Done" testID="report-done" hitSlop={10} style={{ minWidth: 64, minHeight: TOUCH, alignItems: "flex-end", justifyContent: "center" }}>
              <Text style={{ color: colors.brand, fontSize: 17, fontWeight: "600" }}>Done</Text>
            </Pressable>
          ) : (
            <Pressable onPress={send} disabled={!reason || report.isPending} accessibilityRole="button" accessibilityLabel="Send report" accessibilityState={{ disabled: !reason || report.isPending }}
              testID="report-send" hitSlop={10} style={{ minWidth: 64, minHeight: TOUCH, alignItems: "flex-end", justifyContent: "center" }}>
              <Text style={{ color: reason && !report.isPending ? colors.brand : colors.subtle, fontSize: 17, fontWeight: "600" }}>{report.isPending ? "Sending" : "Send"}</Text>
            </Pressable>
          )}
        </View>
        {sent ? (
          <View style={{ alignItems: "center", gap: space.md, paddingHorizontal: space.xl, paddingVertical: space.xl }} testID="report-thanks">
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
              <Icon name="check" size={28} color={colors.brand} />
            </View>
            <Text style={{ color: colors.fg, fontSize: 16, textAlign: "center" }} accessibilityLiveRegion="polite">{REPORT_THANKS}</Text>
            {target.canBlock && !alreadyBlocked ? (
              <Pressable onPress={() => onAlsoBlock(target)} accessibilityRole="button" accessibilityLabel={`Also block ${target.name}`} testID="report-also-block"
                style={({ pressed }) => ({ alignSelf: "stretch", minHeight: TOUCH + 6, borderRadius: radius.md, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: space.sm,
                  backgroundColor: pressed ? colors.hover : colors.surface })}>
                <Icon name="user-x" size={18} color={colors.bad} />
                <Text style={{ color: colors.bad, fontSize: 16, fontWeight: "600" }}>Also block {target.name}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm }} keyboardShouldPersistTaps="handled">
            <Text style={{ color: colors.subtle, fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, marginLeft: space.md, marginTop: space.xs }}>Why are you reporting this?</Text>
            <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, overflow: "hidden" }} accessibilityRole="radiogroup">
              {REPORT_REASONS.map((r, i) => (
                <Pressable key={r.id} onPress={() => setReason(r.id)} accessibilityRole="radio" accessibilityState={{ checked: reason === r.id }} accessibilityLabel={r.label} accessibilityHint={r.hint}
                  testID={`report-reason-${r.id}`}
                  style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", minHeight: TOUCH + 8, paddingLeft: space.md, backgroundColor: pressed ? colors.hover : "transparent" })}>
                  <View style={{ flex: 1, flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingRight: space.md, borderBottomWidth: i === REPORT_REASONS.length - 1 ? 0 : 0.5, borderBottomColor: colors.line }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ color: colors.fg, fontSize: 16 }}>{r.label}</Text>
                      <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={1}>{r.hint}</Text>
                    </View>
                    {reason === r.id ? <Icon name="check" size={20} color={colors.brand} /> : null}
                  </View>
                </Pressable>
              ))}
            </View>
            <Text style={{ color: colors.subtle, fontSize: 13, textTransform: "uppercase", letterSpacing: 0.5, marginLeft: space.md, marginTop: space.md }}>Note (optional)</Text>
            <TextInput value={note} onChangeText={(t) => setNote(t.slice(0, NOTE_MAX))} multiline maxLength={NOTE_MAX} placeholder="Anything that helps our team understand"
              placeholderTextColor={colors.subtle} accessibilityLabel="Note, optional" testID="report-note"
              style={{ minHeight: 88, backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, color: colors.fg, fontSize: 16, textAlignVertical: "top" }} />
            <Text style={{ color: colors.subtle, fontSize: 12, marginLeft: space.md }}>
              {target.targetType === "message" ? "Our team sees this message as it is now, even if it is edited or deleted later." : `Our team reviews ${target.name}'s recent messages.`} {target.name} isn't told who reported.
            </Text>
            {error ? <Text style={{ color: colors.bad, fontSize: 14, marginLeft: space.md }} testID="report-error" accessibilityLiveRegion="assertive">{error}</Text> : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

/** The person menu (DM header, profile): Block or Unblock, and Report. */
export function PersonSafetySheet({ person, visible, onClose, safety, context }: {
  person: { userId: string; name: string } | null; visible: boolean; onClose: () => void; safety: ReturnType<typeof useSafety>; context: ReportContext;
}) {
  if (!person) return null;
  const blocked = safety.isBlocked(person.userId);
  return (
    <ActionSheet visible={visible} title={person.name} subtitle={blocked ? "Blocked. You don't see their messages." : undefined} testID="person-sheet" onClose={onClose}
      options={[
        blocked ? { id: "unblock", label: `Unblock ${person.name}`, icon: "user-check" } : { id: "block", label: `Block ${person.name}`, icon: "user-x", destructive: true },
        { id: "report", label: `Report ${person.name}`, icon: "flag", destructive: true },
      ]}
      onSelect={(id) => {
        onClose();
        if (id === "unblock") safety.unblock(person.userId);
        else if (id === "block") safety.askBlock(person);
        else safety.startReport({ targetType: "user", userId: person.userId, name: person.name, context, canBlock: true });
      }} />
  );
}
