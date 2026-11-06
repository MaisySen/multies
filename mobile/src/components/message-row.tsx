import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Agent, MessageSummary } from "@/api/types";
import { Avatar, Badge, Icon } from "./ui";
import { displayName, shortDate } from "@/lib/format";
import { colors, space } from "@/theme";
import { tr } from "@/i18n";

export const MessageRow = memo(function MessageRow({ m, agents, onPress, onLongPress, showRecipient, note, noteTone, onLabel }: {
  m: MessageSummary; agents?: Agent[]; onPress: () => void; onLongPress?: () => void; showRecipient?: boolean;
  /** 1.10.7: a short line under the snippet ("Back Tomorrow 8:00 am", "Back from snooze"). */
  note?: string; noteTone?: "brand" | "muted";
  /** 1.10.7: a tap on a label chip (shows all mail with that label). */
  onLabel?: (label: string) => void;
}) {
  const agent = m.sentByAgentId ? agents?.find((a) => a.id === m.sentByAgentId) : undefined;
  const who = showRecipient ? tr("m.inbox.to_displayname", { displayName: m.to.map(displayName).join(", ") }) : agent?.name ?? displayName(m.from);
  const labels = m.labels ?? [];
  // MB-361: the name starts with what the row shows first (who), so voice control finds it by the visible words.
  const label = [who, m.subject || tr("m.inbox.no_subject_plain"), m.isRead ? "" : tr("m.inbox.unread"), m.snippet, shortDate(m.date), agent ? tr("m.inbox.written_by_agent", { name: agent.name }) : "", labels.length ? tr("m.inbox.labels_list", { labels: labels.join(", ") }) : "", note ?? ""].filter(Boolean).join(". ");
  const row = (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={onLongPress ? tr("m.inbox.opens_the_conversation_long_press_for_more_actio") : tr("m.inbox.opens_the_conversation")}
      style={({ pressed }) => [s.row, labels.length && onLabel ? { borderBottomWidth: 0, paddingBottom: space.xs } : null, pressed && { backgroundColor: colors.surface }]}>
      <View style={s.dotCol}>{!m.isRead ? <View style={s.dot} /> : null}</View>
      <Avatar name={displayName(m.from)} agent={!!m.sentByAgentId} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={s.top}>
          <Text style={[s.from, !m.isRead && s.strong]} numberOfLines={1}>{who}</Text>
          <Text style={[s.date, !m.isRead && { color: colors.brand }]}>{shortDate(m.date)}</Text>
        </View>
        <Text style={[s.subject, !m.isRead && s.strong]} numberOfLines={1}>{m.subject || tr("m.inbox.no_subject")}</Text>
        <Text style={s.snippet} numberOfLines={2}>{m.snippet}</Text>
        {note ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 }}>
            <Icon name="alarm-clock" size={13} color={noteTone === "brand" ? colors.brand : colors.subtle} />
            <Text style={{ color: noteTone === "brand" ? colors.brand : colors.subtle, fontSize: 13, fontWeight: "600" }} numberOfLines={1} testID={`note-${m.id}`}>{note}</Text>
          </View>
        ) : null}
        {agent || m.isStarred || m.hasAttachments || (labels.length && !onLabel) ? (
          <View style={{ flexDirection: "row", gap: 6, marginTop: 4, alignItems: "center" }}>
            {agent ? <Badge label={tr("m.inbox.agent_name", { name: agent.name })} tone="brand" icon="cpu" /> : null}
            {m.hasAttachments ? <Icon name="paperclip" size={14} /> : null}
            {m.isStarred ? <Icon name="star" size={14} color={colors.warn} /> : null}
            {!onLabel ? labels.slice(0, 3).map((l) => <LabelChip key={l} label={l} />) : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
  if (!labels.length || !onLabel) return row;
  // Labels a person can tap sit under the row, not inside its button (no button inside a button).
  return (
    <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }}>
      {row}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 78, paddingRight: space.lg, paddingBottom: space.sm }}>
        {labels.slice(0, 3).map((l) => <LabelChip key={l} label={l} testID={`label-${m.id}-${l}`} onPress={() => onLabel(l)} />)}
        {labels.length > 3 ? <Text style={{ color: colors.subtle, fontSize: 12, alignSelf: "center" }}>+{labels.length - 3}</Text> : null}
      </View>
    </View>
  );
});

/** A thread label: a small pill; with onPress it shows all mail with that label. */
export function LabelChip({ label, onPress, testID }: { label: string; onPress?: () => void; testID?: string }) {
  const chip = (
    <Text numberOfLines={1} testID={onPress ? undefined : testID}
      style={{ color: colors.brandHover, backgroundColor: colors.brandSoft, fontSize: 12, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, overflow: "hidden", maxWidth: 140 }}>{label}</Text>
  );
  if (!onPress) return chip;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={tr("m.inbox.show_mail_labelled_label", { label: label })} testID={testID} hitSlop={8}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, minHeight: 44, marginVertical: -10, justifyContent: "center" })}>{chip}</Pressable>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", gap: space.md, paddingVertical: space.md, paddingRight: space.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, minHeight: 76 },
  dotCol: { width: 14, alignItems: "center", paddingTop: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand },
  top: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  from: { color: colors.fg, fontSize: 16, flex: 1 },
  date: { color: colors.subtle, fontSize: 13 },
  subject: { color: colors.fg, fontSize: 15 },
  snippet: { color: colors.muted, fontSize: 14, lineHeight: 19 },
  strong: { fontWeight: "700" },
});
