import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Agent, MessageSummary } from "@/api/types";
import { Avatar, Badge, Icon } from "./ui";
import { displayName, shortDate } from "@/lib/format";
import { colors, space } from "@/theme";

export const MessageRow = memo(function MessageRow({ m, agents, onPress, onLongPress, showRecipient }: { m: MessageSummary; agents?: Agent[]; onPress: () => void; onLongPress?: () => void; showRecipient?: boolean }) {
  const agent = m.sentByAgentId ? agents?.find((a) => a.id === m.sentByAgentId) : undefined;
  const who = showRecipient ? `To: ${m.to.map(displayName).join(", ")}` : agent?.name ?? displayName(m.from);
  const label = `${m.isRead ? "" : "Unread. "}${who}. ${m.subject || "No subject"}. ${m.snippet}. ${shortDate(m.date)}${agent ? `. Written by agent ${agent.name}` : ""}`;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={onLongPress ? "Opens the conversation. Long press for more actions." : "Opens the conversation"}
      style={({ pressed }) => [s.row, pressed && { backgroundColor: colors.surface }]}>
      <View style={s.dotCol}>{!m.isRead ? <View style={s.dot} /> : null}</View>
      <Avatar name={displayName(m.from)} agent={!!m.sentByAgentId} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={s.top}>
          <Text style={[s.from, !m.isRead && s.strong]} numberOfLines={1}>{who}</Text>
          <Text style={[s.date, !m.isRead && { color: colors.brand }]}>{shortDate(m.date)}</Text>
        </View>
        <Text style={[s.subject, !m.isRead && s.strong]} numberOfLines={1}>{m.subject || "(no subject)"}</Text>
        <Text style={s.snippet} numberOfLines={2}>{m.snippet}</Text>
        {agent || m.isStarred || m.hasAttachments ? (
          <View style={{ flexDirection: "row", gap: 6, marginTop: 4, alignItems: "center" }}>
            {agent ? <Badge label={`Agent: ${agent.name}`} tone="brand" icon="cpu" /> : null}
            {m.hasAttachments ? <Icon name="paperclip" size={14} /> : null}
            {m.isStarred ? <Icon name="star" size={14} color={colors.warn} /> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

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
