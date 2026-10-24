import { useState } from "react";
import { Alert, Modal, Platform, Pressable, Share, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import * as Clipboard from "expo-clipboard";
import { Avatar, Icon, IconButton, type IconName } from "@/components/ui";
import { API_BASE } from "@/config";
import { bytes } from "@/lib/format";
import { encodeMentions, filterPeople, insertMention, linkLabel, mentionQuery, messageTime, plainText, segments } from "@/lib/chat";
import type { ChatAttachment, ChatLink, ChatMessage, ChatPerson } from "@/api/types";
import { colors, font, radius, space, TOUCH } from "@/theme";
import { useReduceMotion } from "@/lib/motion";

const LINK_ICON: Record<ChatLink["type"], IconName> = { task: "check-square", thread: "mail", doc: "file-text" };

/** Opens what a chip points at: a task or an email thread in the app, a doc on the web. */
export function openLink(l: ChatLink) {
  if (l.type === "task") router.push({ pathname: "/task/[id]", params: { id: l.id } });
  else if (l.type === "thread") router.push({ pathname: "/thread/[id]", params: { id: l.id } });
  else WebBrowser.openBrowserAsync(`${API_BASE}/app/docs/${encodeURIComponent(l.id)}`).catch(() => {});
}

/** The file address on the server. It opens in the system browser, which uses its own MyMail sign in. */
export function fileUrl(a: ChatAttachment) {
  return `${API_BASE}/api/chat/files/${encodeURIComponent(a.id)}`;
}

export function LinkChip({ link }: { link: ChatLink }) {
  const label = linkLabel(link);
  const kind = link.type === "task" ? "Task" : link.type === "thread" ? "Email" : "Doc";
  return (
    <Pressable onPress={() => openLink(link)} accessibilityRole="button" accessibilityLabel={`${kind}: ${label}`} testID={`chip-${link.type}-${link.id}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", minHeight: 34, paddingHorizontal: 10, borderRadius: radius.pill,
        borderWidth: 1, borderColor: colors.brandLine, backgroundColor: pressed ? colors.hover : colors.brandSoft })}>
      <Icon name={LINK_ICON[link.type]} size={14} color={colors.brand} />
      <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function AttachmentRow({ a, sample }: { a: ChatAttachment; sample: boolean }) {
  const open = () => {
    if (sample) { Alert.alert("Sample file", "Files in the sample workspace are examples, so there is nothing to open."); return; }
    WebBrowser.openBrowserAsync(fileUrl(a)).catch(() => {});
  };
  const share = () => { if (!sample) Share.share(Platform.OS === "ios" ? { url: fileUrl(a) } : { message: fileUrl(a), title: a.filename }).catch(() => {}); };
  return (
    <Pressable onPress={open} onLongPress={share} accessibilityRole="button" accessibilityLabel={`Attachment ${a.filename}, ${bytes(a.size)}`} accessibilityHint="Opens the file. Press and hold to share it."
      testID={`attachment-${a.id}`}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.sm, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: pressed ? colors.hover : colors.elevated })}>
      <Icon name="paperclip" size={16} />
      <Text style={{ color: colors.fg, fontSize: 14, flex: 1 }} numberOfLines={1}>{a.filename}</Text>
      <Text style={font.tiny}>{bytes(a.size)}</Text>
    </Pressable>
  );
}

/** One chat message: author, time, the body with "@Name" mentions, chips for linked items, files and the reply count. */
export function ChatMessageRow({ m, meId, sample, onLongPress, onOpenThread, showReplies = true }: {
  m: ChatMessage; meId: string | null; sample: boolean; onLongPress?: (m: ChatMessage) => void; onOpenThread?: (m: ChatMessage) => void; showReplies?: boolean;
}) {
  const parts = segments(m, meId);
  const agent = m.author.type === "agent";
  return (
    <Pressable onLongPress={() => onLongPress?.(m)} delayLongPress={350} testID={`chat-msg-${m.id}`}
      accessibilityHint={onLongPress ? "Press and hold for more actions" : undefined}
      style={({ pressed }) => ({ flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingVertical: 10, backgroundColor: pressed ? colors.surface : "transparent" })}>
      <Avatar name={m.author.name} agent={agent} size={36} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, flexWrap: "wrap" }}>
          <Text style={{ color: colors.fg, fontWeight: "700", fontSize: 15 }}>{m.author.name}</Text>
          {agent ? <Text style={{ color: colors.brand, fontSize: 12, fontWeight: "600" }}>Agent</Text> : null}
          {m.author.type === "guest" ? <Text style={{ color: colors.warn, fontSize: 12, fontWeight: "600" }}>Guest</Text> : null}
          <Text style={font.tiny}>{messageTime(m.createdAt)}{m.editedAt ? " (edited)" : ""}</Text>
        </View>
        {m.deleted ? <Text style={[font.small, { fontStyle: "italic" }]}>This message was deleted.</Text> : (
          <Text style={font.body} selectable>
            {parts.map((s, i) => s.kind === "text" ? <Text key={i}>{s.text}</Text>
              : s.kind === "mention" ? <Text key={i} style={{ color: colors.brand, fontWeight: "600", backgroundColor: s.self ? colors.brandSoft : undefined }}>{s.text}</Text>
              : <Text key={i} style={{ color: colors.brand }} onPress={s.link ? () => openLink(s.link!) : undefined}>{s.text}</Text>)}
          </Text>
        )}
        {m.links.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{m.links.map((l) => <LinkChip key={`${l.type}:${l.id}`} link={l} />)}</View> : null}
        {m.attachments.length ? <View style={{ gap: 6 }}>{m.attachments.map((a) => <AttachmentRow key={a.id} a={a} sample={sample} />)}</View> : null}
        {showReplies && m.replyCount > 0 ? (
          <Pressable onPress={() => onOpenThread?.(m)} accessibilityRole="button" accessibilityLabel={`${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}, open thread`} testID={`replies-${m.id}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 32 }}>
            <Icon name="corner-down-right" size={14} color={colors.brand} />
            <Text style={{ color: colors.brand, fontWeight: "600", fontSize: 14 }}>{m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}</Text>
            {m.lastReplyAt ? <Text style={font.tiny}>last {messageTime(m.lastReplyAt)}</Text> : null}
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

/** The press and hold menu on a message. */
export function MessageMenu({ m, onClose, onReply, onMakeTask, busy }: {
  m: ChatMessage | null; onClose: () => void; onReply?: (m: ChatMessage) => void; onMakeTask: (m: ChatMessage) => void; busy?: boolean;
}) {
  const reduceMotion = useReduceMotion();
  if (!m) return null;
  const item = (icon: IconName, label: string, run: () => void, testID: string) => (
    <Pressable onPress={run} accessibilityRole="button" accessibilityLabel={label} testID={testID} disabled={busy}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52, paddingHorizontal: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
      <Icon name={icon} size={19} color={colors.fg} />
      <Text style={{ color: colors.fg, fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal transparent animationType={reduceMotion ? "none" : "slide"} visible onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" }} onPress={onClose} accessibilityLabel="Close menu">
        <View style={{ backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingBottom: space.xl, paddingTop: space.sm }} accessibilityViewIsModal>
          <Text style={[font.small, { paddingHorizontal: space.lg, paddingVertical: space.sm }]} numberOfLines={2}>{m.author.name}: {plainText(m)}</Text>
          {item("check-square", busy ? "Making task..." : "Make task", () => onMakeTask(m), "menu-make-task")}
          {onReply && !m.parentId ? item("corner-down-right", "Reply in thread", () => { onClose(); onReply(m); }, "menu-reply") : null}
          {item("copy", "Copy text", () => { Clipboard.setStringAsync(plainText(m)).catch(() => {}); onClose(); }, "menu-copy")}
          {item("x", "Cancel", onClose, "menu-cancel")}
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * Message box with a simple @ mention picker: type @ and a few letters, tap a name, and it is
 * sent as a real mention. Sending a file is not in this version; files sent on the web show here.
 */
export function Composer({ people, placeholder, onSend, sending, testID = "composer" }: {
  people: ChatPerson[]; placeholder: string; onSend: (body: string) => Promise<unknown>; sending?: boolean; testID?: string;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ChatPerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const query = mentionQuery(text);
  const matches = query === null ? [] : filterPeople(people, query);
  const send = async () => {
    const body = encodeMentions(text.trim(), picked);
    if (!body) return;
    setError(null);
    try {
      await onSend(body);
      setText(""); setPicked([]);
    } catch (e) {
      setError((e as Error).message || "Couldn't send. Try again.");
    }
  };
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg }}>
      {matches.length ? (
        <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line }} accessibilityLabel="People to mention">
          {matches.map((p) => (
            <Pressable key={p.id} testID={`mention-${p.id}`} accessibilityRole="button" accessibilityLabel={`Mention ${p.name}`}
              onPress={() => { setText(insertMention(text, p.name)); setPicked((x) => [...x, p]); }}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: TOUCH, paddingHorizontal: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
              <Avatar name={p.name} agent={p.type === "agent"} size={28} />
              <Text style={{ color: colors.fg, fontSize: 15, flex: 1 }}>{p.name}</Text>
              <Text style={font.tiny}>{p.type === "agent" ? "Agent" : p.email}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Text style={{ color: colors.bad, fontSize: 13, paddingHorizontal: space.lg, paddingTop: space.sm }} accessibilityLiveRegion="polite">{error}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, padding: space.sm, paddingHorizontal: space.md }}>
        <TextInput value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor={colors.subtle} multiline testID={testID}
          accessibilityLabel={placeholder} accessibilityHint="Type @ to mention someone"
          style={{ flex: 1, minHeight: TOUCH, maxHeight: 140, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, color: colors.fg, paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11, fontSize: 16 }} />
        <IconButton icon="send" label="Send" onPress={send} color={text.trim() && !sending ? colors.brand : colors.subtle} testID={`${testID}-send`} />
      </View>
    </View>
  );
}
