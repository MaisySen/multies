import { useState } from "react";
import { Alert, Modal, Platform, Pressable, Share, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Avatar, Icon, IconButton, type IconName } from "@/components/ui";
import { API_BASE } from "@/config";
import { bytes } from "@/lib/format";
import { CHAT_FILES_PER_MESSAGE, linkStillGood, pickChatFiles, progressLabel, sendErrorText, toOutgoing, type OutgoingFile, type PickedFile } from "@/lib/chat-files";
import { useSession } from "@/lib/session";
import { encodeMentions, filterPeople, insertMention, linkLabel, mentionQuery, messageTime, plainText, segments } from "@/lib/chat";
import type { ChatAttachment, ChatLink, ChatMessage, ChatPerson } from "@/api/types";
import { colors, font, radius, space, TOUCH } from "@/theme";
import { useReduceMotion } from "@/lib/motion";
import { thud } from "@/lib/haptics";
import { openInApp } from "@/lib/web-open";

const LINK_ICON: Record<ChatLink["type"], IconName> = { task: "check-square", thread: "mail", doc: "file-text" };

/** Opens what a chip points at: a task or an email thread in the app, a doc on the web. */
export function openLink(l: ChatLink) {
  if (l.type === "task") router.push({ pathname: "/task/[id]", params: { id: l.id } });
  else if (l.type === "thread") router.push({ pathname: "/thread/[id]", params: { id: l.messageId ?? l.id } });
  else router.push({ pathname: "/doc/[id]", params: { id: l.id } }); // M3: docs read in the app
}

/** The file address on the server. The signed link opens in the system browser with no sign in; older servers send none. */
export function fileUrl(a: ChatAttachment) {
  if (a.url && a.url.startsWith("/api/chat/files/")) return `${API_BASE}${a.url}`;
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

function AttachmentRow({ a, messageId, sample }: { a: ChatAttachment; messageId: string; sample: boolean }) {
  const { api } = useSession();
  // Signed links last at least 15 minutes. A screen left open longer asks the server for a fresh one.
  const freshUrl = async () => {
    if (linkStillGood(a.url)) return fileUrl(a);
    try {
      const { message } = await api.chatMessage(messageId);
      const again = message.attachments.find((x) => x.id === a.id);
      return fileUrl(again ?? a);
    } catch {
      return fileUrl(a);
    }
  };
  const open = async () => {
    if (sample) { Alert.alert("Sample file", "Files in the sample workspace are examples, so there is nothing to open."); return; }
    await openInApp(await freshUrl());
  };
  const share = async () => {
    if (sample) return;
    const url = await freshUrl();
    Share.share(Platform.OS === "ios" ? { url } : { message: url, title: a.filename }).catch(() => {});
  };
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
export function ChatMessageRow({ m, meId, sample, onLongPress, onOpenThread, showReplies = true, grouped = false }: {
  m: ChatMessage; meId: string | null; sample: boolean; onLongPress?: (m: ChatMessage) => void; onOpenThread?: (m: ChatMessage) => void; showReplies?: boolean;
  /** R35: a follow on message from the same person within a few minutes shows without the name and avatar. */
  grouped?: boolean;
}) {
  const parts = segments(m, meId);
  const agent = m.author.type === "agent";
  return (
    <Pressable onLongPress={() => { thud(); onLongPress?.(m); }} delayLongPress={350} testID={`chat-msg-${m.id}`}
      accessibilityLabel={grouped ? `${m.author.name}, ${messageTime(m.createdAt)}` : undefined}
      accessibilityHint={onLongPress ? "Press and hold for more actions" : undefined}
      style={({ pressed }) => ({ flexDirection: "row", gap: space.md, paddingHorizontal: space.lg, paddingTop: grouped ? 2 : 10, paddingBottom: grouped ? 4 : 6, backgroundColor: pressed ? colors.surface : "transparent" })}>
      {grouped ? <View style={{ width: 36 }} /> : <Avatar name={m.author.name} agent={agent} size={36} />}
      <View style={{ flex: 1, gap: 6 }}>
        {grouped ? null : <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, flexWrap: "wrap" }}>
          <Text style={{ color: colors.fg, fontWeight: "700", fontSize: 15 }}>{m.author.name}</Text>
          {agent ? <Text style={{ color: colors.brand, fontSize: 12, fontWeight: "600" }}>Agent</Text> : null}
          {m.author.type === "guest" ? <Text style={{ color: colors.warn, fontSize: 12, fontWeight: "600" }}>Guest</Text> : null}
          <Text style={font.tiny}>{messageTime(m.createdAt)}{m.editedAt ? " (edited)" : ""}</Text>
        </View>}
        {m.deleted ? <Text style={[font.small, { fontStyle: "italic" }]}>This message was deleted.</Text> : (
          <Text style={font.body} selectable>
            {parts.map((s, i) => s.kind === "text" ? <Text key={i}>{s.text}</Text>
              : s.kind === "mention" ? <Text key={i} style={{ color: colors.brand, fontWeight: "600", backgroundColor: s.self ? colors.brandSoft : undefined }}>{s.text}</Text>
              : <Text key={i} style={{ color: colors.brand }} onPress={s.link ? () => openLink(s.link!) : undefined}>{s.text}</Text>)}
          </Text>
        )}
        {m.links.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{m.links.map((l) => <LinkChip key={`${l.type}:${l.id}`} link={l} />)}</View> : null}
        {m.attachments.length ? <View style={{ gap: 6 }}>{m.attachments.map((a) => <AttachmentRow key={a.id} a={a} messageId={m.id} sample={sample} />)}</View> : null}
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
export function MessageMenu({ m, onClose, onReply, onMakeTask, busy, onReport, onBlock }: {
  m: ChatMessage | null; onClose: () => void; onReply?: (m: ChatMessage) => void; onMakeTask: (m: ChatMessage) => void; busy?: boolean;
  /** R35: report and block (guideline 1.2). onBlock is passed only when the author can be blocked (someone else, not an agent). */
  onReport?: (m: ChatMessage) => void; onBlock?: (m: ChatMessage) => void;
}) {
  const reduceMotion = useReduceMotion();
  if (!m) return null;
  const item = (icon: IconName, label: string, run: () => void, testID: string, danger = false) => (
    <Pressable onPress={run} accessibilityRole="button" accessibilityLabel={label} testID={testID} disabled={busy}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 52, paddingHorizontal: space.lg, backgroundColor: pressed ? colors.hover : "transparent" })}>
      <Icon name={icon} size={19} color={danger ? colors.bad : colors.fg} />
      <Text style={{ color: danger ? colors.bad : colors.fg, fontSize: 16 }}>{label}</Text>
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
          {onReport && !m.deleted ? item("flag", "Report message", () => { onClose(); onReport(m); }, "menu-report", true) : null}
          {onBlock ? item("user-x", `Block ${m.author.name}`, () => { onClose(); onBlock(m); }, "menu-block", true) : null}
          {item("x", "Cancel", onClose, "menu-cancel")}
        </View>
      </Pressable>
    </Modal>
  );
}

/**
 * Message box with a simple @ mention picker: type @ and a few letters, tap a name, and it is
 * sent as a real mention. The paperclip attaches up to 5 files (10 MB each) that go with the message,
 * with progress while they upload.
 */
export function Composer({ people, placeholder, onSend, sending, testID = "composer", allowFiles = true }: {
  people: ChatPerson[]; placeholder: string;
  onSend: (body: string, files?: OutgoingFile[], onProgress?: (fraction: number) => void) => Promise<unknown>;
  sending?: boolean; testID?: string; allowFiles?: boolean;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ChatPerson[]>([]);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = mentionQuery(text);
  const matches = query === null ? [] : filterPeople(people, query);
  const busy = !!sending || progress !== null;
  const ready = (!!text.trim() || files.length > 0) && !busy;
  const attach = async () => {
    if (busy) return;
    if (files.length >= CHAT_FILES_PER_MESSAGE) { setError(`You can attach up to ${CHAT_FILES_PER_MESSAGE} files at a time.`); return; }
    try {
      const got = await pickChatFiles(files.length);
      setError(got.problem);
      if (got.files.length) setFiles((x) => [...x, ...got.files]);
    } catch (e) {
      setError(sendErrorText(e));
    }
  };
  const send = async () => {
    const body = encodeMentions(text.trim(), picked);
    if ((!body && !files.length) || busy) return;
    setError(null);
    try {
      if (files.length) {
        setProgress(0);
        const outgoing = await toOutgoing(files);
        await onSend(body, outgoing, setProgress);
      } else {
        await onSend(body);
      }
      setText(""); setPicked([]); setFiles([]);
    } catch (e) {
      setError(sendErrorText(e));
    } finally {
      setProgress(null);
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
      {files.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: space.md, paddingTop: space.sm }} accessibilityLabel="Files to send">
          {files.map((f, i) => (
            <View key={`${f.uri}-${i}`} testID={`${testID}-file-${i}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", minHeight: 34, paddingLeft: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
              <Icon name="paperclip" size={14} />
              <Text style={{ color: colors.fg, fontSize: 14, flexShrink: 1 }} numberOfLines={1}>{f.name}</Text>
              {f.size !== undefined ? <Text style={font.tiny}>{bytes(f.size)}</Text> : null}
              <Pressable onPress={() => !busy && setFiles((x) => x.filter((_, j) => j !== i))} disabled={busy} hitSlop={8}
                accessibilityRole="button" accessibilityLabel={`Remove ${f.name}`} testID={`${testID}-file-${i}-remove`}
                style={{ minWidth: 34, minHeight: 34, alignItems: "center", justifyContent: "center" }}>
                <Icon name="x" size={14} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {progress !== null ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: 4 }} testID={`${testID}-progress`}
          accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }} accessibilityLabel={progressLabel(progress)}>
          <Text style={font.tiny} accessibilityLiveRegion="polite">{progressLabel(progress)}</Text>
          <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.line, overflow: "hidden" }}>
            <View style={{ height: 3, width: `${Math.round(Math.max(0.02, progress) * 100)}%`, backgroundColor: colors.brand }} />
          </View>
        </View>
      ) : null}
      {error ? <Text style={{ color: colors.bad, fontSize: 13, paddingHorizontal: space.lg, paddingTop: space.sm }} accessibilityLiveRegion="polite" testID={`${testID}-error`}>{error}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm, padding: space.sm, paddingHorizontal: space.md }}>
        {allowFiles ? <IconButton icon="paperclip" label="Attach files" onPress={attach} color={busy ? colors.subtle : colors.fg} testID={`${testID}-attach`} /> : null}
        <TextInput value={text} onChangeText={setText} placeholder={placeholder} placeholderTextColor={colors.subtle} multiline testID={testID}
          accessibilityLabel={placeholder} accessibilityHint="Type @ to mention someone"
          style={{ flex: 1, minHeight: TOUCH, maxHeight: 140, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, color: colors.fg, paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11, fontSize: 16 }} />
        <IconButton icon="send" label="Send" onPress={send} color={ready ? colors.brand : colors.subtle} testID={`${testID}-send`} />
      </View>
    </View>
  );
}
