import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Button, Chip, Field } from "@/components/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useOverview, useThread } from "@/lib/queries";
import { useSession } from "@/lib/session";
import { parkDraft, recipientsLabel, sendHold, takeParkedDraft, trackHeld, useUndoSeconds, type HeldDraft } from "@/lib/undo-send";
import { EMAIL_RE, displayName, parseRecipients, quoteForReply } from "@/lib/format";
import { replyAllCc } from "@/lib/quote";
import { askAboutEmptySubject, needsSubjectPrompt } from "@/lib/subject-prompt";
import { takePendingToolFiles, type ToolFileRef } from "@/lib/tool-run";
import { FileChip } from "@/components/tool-ui";
import { colors, radius, space } from "@/theme";
import { tr } from "@/i18n";
import { ExtraButton, SavedRepliesSheet, SecureSheet, SendLaterSheet, fileData, pickComposeFiles, secureSeal } from "@/components/compose-extras";
import { Note } from "@/components/mpar3-ui";
import { insertAt, type ComposeFile, type SendLaterPreset } from "@/lib/mpar3";
import { useSendLater } from "@/lib/mpar3-queries";
import { toolFeatureOn, useWebConfig } from "@/lib/web-config";
import { tick, success } from "@/lib/haptics";

export default function Compose() {
  const params = useLocalSearchParams<{ replyTo?: string; forward?: string; to?: string; subject?: string; restore?: string; all?: string; tools?: string }>();
  // A message taken back with Undo comes back exactly as it was.
  const [parked] = useState(() => (params.restore ? takeParkedDraft() : null));
  // Tools P2: results from Tools ("Attach to a new email") ride as the server's download tokens.
  const [toolFiles, setToolFiles] = useState<ToolFileRef[]>(() => parked?.toolFiles ?? (params.tools ? takePendingToolFiles() : []));
  const sourceId = params.replyTo ?? params.forward ?? "";
  const source = useThread(sourceId, !!sourceId);
  const original = sourceId ? source.data?.thread.find((m) => m.id === sourceId) ?? source.data?.message : undefined;
  const overview = useOverview();
  const mailboxes = useMemo(() => overview.data?.filter((m) => m.kind !== "agent") ?? [], [overview.data]);
  const { api } = useSession();
  const qc = useQueryClient();
  const [undoSeconds] = useUndoSeconds();

  const [from, setFrom] = useState<string | undefined>(parked?.mailboxId);
  const [to, setTo] = useState(parked?.to ?? params.to ?? "");
  const [cc, setCc] = useState(parked?.cc ?? "");
  const [showCc, setShowCc] = useState(!!parked?.cc);
  const subjectRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [subject, setSubject] = useState(parked?.subject ?? params.subject ?? "");
  const [text, setText] = useState(parked?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(!!parked);
  // MPAR3: files from the phone, saved replies, send later and send securely.
  const [files, setFiles] = useState<ComposeFile[]>(() => parked?.files ?? []);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [sheet, setSheet] = useState<"replies" | "later" | "secure" | null>(null);
  const sel = useRef({ start: 0, end: 0 });
  const bodyRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [secretSeed, setSecretSeed] = useState("");
  const web = useWebConfig();
  const secureOn = toolFeatureOn(web.data, "secrets") && !!secureSeal();
  const later = useSendLater();
  const replyTo = parked ? parked.inReplyToId : params.replyTo;
  const forwardOf = parked ? parked.forwardOf : params.forward;

  useEffect(() => {
    if (!from && mailboxes.length) setFrom(original ? mailboxes.find((m) => original.mailboxId === m.id)?.id ?? mailboxes[0].id : mailboxes[0].id);
  }, [mailboxes, from, original]);

  useEffect(() => {
    if (!original || prefilled) return;
    setPrefilled(true);
    const subj = original.subject || "";
    if (params.replyTo) {
      const replyAddress = original.folder === "sent" ? original.to[0]?.address ?? "" : original.replyTo || original.from.address;
      setTo(replyAddress);
      // R36: Reply all from the thread bar copies everyone else on the message, minus my own addresses.
      if (params.all === "1") {
        const others = replyAllCc(original, replyAddress, mailboxes.map((m) => m.address));
        if (others.length) { setCc(others.join(", ")); setShowCc(true); }
      }
      setSubject(/^re:/i.test(subj) ? subj : tr("m.compose.re_subj", { subj: subj }));
      setText(quoteForReply(original.text ?? "", displayName(original.from), original.date));
    } else {
      setSubject(/^fwd?:/i.test(subj) ? subj : tr("m.compose.fwd_subj", { subj: subj }));
      setText(`\n\n---------- Forwarded message ----------\nFrom: ${displayName(original.from)} <${original.from.address}>\nSubject: ${subj}\n\n${original.text ?? ""}`);
    }
  }, [original, prefilled, params.replyTo, params.all, mailboxes]);

  const submit = async () => {
    setError(null);
    const toList = parseRecipients(to);
    const ccList = parseRecipients(cc);
    const bad = [...toList, ...ccList].find((a) => !EMAIL_RE.test(a));
    if (!from) return setError(tr("m.compose.you_need_an_email_address_to_send_from_tap_add_a"));
    if (!toList.length) return setError(tr("m.compose.add_at_least_one_recipient"));
    if (bad) return setError(tr("m.compose.bad_doesn_t_look_like_an_email_address", { bad: bad }));
    if (!subject.trim() && !text.trim() && !toolFiles.length && !files.length) return setError(tr("m.compose.write_a_subject_or_a_message_first"));
    // A gentle nudge, never a block: mail with no subject is more likely to go to spam.
    if (needsSubjectPrompt(subject) && Platform.OS !== "web" && !(await askAboutEmptySubject())) return subjectRef.current?.focus();
    // Undo send: close Compose now and post when the hold ends; the bar above the tabs offers Undo.
    const draft: HeldDraft = { mailboxId: from, to, cc, subject, text, inReplyToId: replyTo, forwardOf, toolFiles: toolFiles.length ? toolFiles : undefined, files: files.length ? files : undefined };
    let attachments: { filename: string; contentType: string; data: string }[] | undefined;
    if (files.length) {
      try { attachments = await Promise.all(files.map((f) => fileData(f))); }
      catch (e) { return setError((e as Error).message); }
    }
    const input = { mailboxId: from, to: toList, cc: ccList.length ? ccList : undefined, subject: subject.trim(), text, inReplyToId: replyTo, ...(toolFiles.length ? { toolFiles: toolFiles.map((f) => f.token) } : {}), ...(attachments ? { attachments } : {}) };
    const idempotencyKey = Crypto.randomUUID();
    const hold = sendHold.hold({
      seconds: undoSeconds,
      send: () => api.send(input, idempotencyKey),
      onSent: () => {
        void qc.invalidateQueries({ queryKey: ["messages"] });
        void qc.invalidateQueries({ queryKey: ["thread"] });
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      },
      onError: (e) => {
        // Nothing typed is lost: the message goes back into Compose with the reason.
        parkDraft(draft);
        Alert.alert(tr("m.compose.couldn_t_send"), tr("m.compose.message_your_message_is_back_in_compose", { message: (e as Error).message || "Check your connection and try again." }), [
          { text: tr("m.compose.open"), onPress: () => router.push({ pathname: "/compose", params: { restore: "1" } }) },
        ]);
      },
    });
    trackHeld({ hold, draft, label: recipientsLabel([...toList, ...ccList]) });
    if (router.canGoBack()) router.back(); else router.replace("/inbox");
  };

  const attach = async () => {
    tick(); setFileNote(null);
    const r = await pickComposeFiles(files);
    if (r.files.length) setFiles((cur) => [...cur, ...r.files]);
    if (r.problem) setFileNote(r.problem);
  };
  const putText = (piece: string) => {
    const r = insertAt(text, sel.current, piece);
    setText(r.text);
    sel.current = { start: r.cursor, end: r.cursor };
  };
  const laterBlocked = files.length || toolFiles.length ? tr("m.compose3.later_files") : null;
  const schedule = async (when: { preset: SendLaterPreset } | { at: string }) => {
    setError(null);
    const toList = parseRecipients(to);
    const ccList = parseRecipients(cc);
    const bad = [...toList, ...ccList].find((a) => !EMAIL_RE.test(a));
    if (!from) throw new Error(tr("m.compose.you_need_an_email_address_to_send_from_tap_add_a"));
    if (!toList.length) throw new Error(tr("m.compose.add_at_least_one_recipient"));
    if (bad) throw new Error(tr("m.compose.bad_doesn_t_look_like_an_email_address", { bad: bad }));
    await later.mutateAsync({ message: { mailboxId: from, to: toList, cc: ccList.length ? ccList : undefined, subject: subject.trim(), text, inReplyToId: replyTo }, when, key: Crypto.randomUUID() });
    success();
    setSheet(null);
    if (Platform.OS === "web") globalThis.alert?.(tr("m.compose3.scheduled"));
    else Alert.alert(tr("m.compose3.scheduled"), tr("m.compose3.scheduled_body"));
    if (router.canGoBack()) router.back(); else router.replace("/inbox");
  };

  const discard = () => {
    if (!text.trim() && !to.trim() && !toolFiles.length && !files.length) return router.back();
    if (Platform.OS === "web") return router.back();
    Alert.alert(tr("m.compose.discard_this_message"), tr("m.compose.what_you_ve_written_will_be_lost"), [
      { text: tr("m.compose.keep_writing"), style: "cancel" },
      { text: tr("m.compose.discard"), style: "destructive", onPress: () => router.back() },
    ]);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        title: replyTo ? tr("m.compose.reply") : forwardOf ? tr("m.compose.forward") : tr("m.compose.new_message"),
        headerLeft: () => <Button variant="ghost" label={tr("m.compose.cancel")} onPress={discard} />,
        headerRight: () => <Button label={tr("m.compose.send")} icon="send" onPress={submit} testID="send" style={{ minHeight: 44, paddingHorizontal: 14 }} />,
      }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
        {mailboxes.length > 1 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{tr("m.compose.from")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {mailboxes.map((m) => <Chip key={m.id} label={m.address} selected={from === m.id} onPress={() => setFrom(m.id)} />)}
            </View>
          </View>
        ) : mailboxes[0] ? <Text style={{ color: colors.subtle, fontSize: 14 }}>{tr("m.compose3.from_address", { address: mailboxes[0].address })}</Text> : overview.data ? (
          <View style={{ backgroundColor: colors.brandSoft, borderRadius: radius.md, padding: space.md, gap: space.sm }} testID="no-mailbox">
            <Text style={{ color: colors.fg, fontSize: 15 }}>{tr("m.compose.you_don_t_have_an_email_address_to_send_from_yet")}</Text>
            <Button label={tr("m.compose.add_an_email_address")} icon="at-sign" variant="secondary" testID="add-address" onPress={() => router.push("/email-setup")} style={{ alignSelf: "flex-start", minHeight: 44 }} />
          </View>
        ) : null}
        <Field label={tr("m.compose.to")} testID="to" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder={tr("m.compose.name_example_com_au")} />
        {showCc ? <Field label={tr("m.compose.cc")} value={cc} onChangeText={setCc} autoCapitalize="none" keyboardType="email-address" /> : (
          <Button variant="ghost" label={tr("m.compose.add_cc")} icon="plus" onPress={() => setShowCc(true)} style={{ alignSelf: "flex-start", minHeight: 44 }} />
        )}
        <Field ref={subjectRef} label={tr("m.compose.subject")} testID="subject" value={subject} onChangeText={setSubject} />
        {toolFiles.length ? (
          <View style={{ gap: space.sm }} testID="compose-tool-files">
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{toolFiles.length === 1 ? tr("m.compose.attachment") : tr("m.compose3.n_attachments", { count: toolFiles.length })}</Text>
            {toolFiles.map((f) => <FileChip key={f.token} name={f.name} size={f.bytes} onRemove={() => setToolFiles((cur) => cur.filter((x) => x.token !== f.token))} />)}
            <Text style={{ color: colors.subtle, fontSize: 12.5 }}>{tr("m.compose.tools_results_are_kept_for_an_hour_so_send_withi")}</Text>
          </View>
        ) : null}
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }} nativeID="body-label">{tr("m.compose.message")}</Text>
          <TextInput ref={bodyRef} testID="body" value={text} onChangeText={setText} multiline onSelectionChange={(e) => { sel.current = e.nativeEvent.selection; }} accessibilityLabel={tr("m.compose.message")} accessibilityLabelledBy="body-label"
            placeholder={tr("m.compose.write_your_message")} placeholderTextColor={colors.subtle} selectionColor={colors.brand} textAlignVertical="top"
            style={{ minHeight: 220, color: colors.fg, fontSize: 16, lineHeight: 23, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface }} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }} testID="compose-extras">
          <ExtraButton icon="paperclip" label={tr("m.compose3.attach")} onPress={attach} testID="compose-attach" />
          <ExtraButton icon="layers" label={tr("m.compose3.saved_replies")} onPress={() => { tick(); setSheet("replies"); }} testID="compose-replies" />
          <ExtraButton icon="clock" label={tr("m.compose3.send_later")} onPress={() => { tick(); setSheet("later"); }} testID="compose-later" />
          {secureOn ? <ExtraButton icon="lock" label={tr("m.compose3.send_securely")} testID="compose-secure"
            onPress={() => { tick(); setSecretSeed(text.slice(sel.current.start, sel.current.end)); setSheet("secure"); }} /> : null}
        </View>
        {files.length ? (
          <View style={{ gap: space.sm }} testID="compose-files">
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{tr("m.compose3.n_files", { count: files.length })}</Text>
            {files.map((f) => <FileChip key={f.id} name={f.name} size={f.size} onRemove={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))} />)}
          </View>
        ) : null}
        {fileNote ? <Note tone="bad">{fileNote}</Note> : null}
        <Text style={{ color: colors.subtle, fontSize: 13 }}>{tr("m.compose.after_send_you_have_count_seconds_to_undo_change", { count: undoSeconds })}</Text>
        {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityRole="alert">{error}</Text> : null}
      </ScrollView>
      <SavedRepliesSheet visible={sheet === "replies"} onClose={() => setSheet(null)} to={to} mailboxId={from}
        onPick={(r) => { putText(r.body); if (r.subject && !subject.trim()) setSubject(r.subject); }} />
      <SendLaterSheet visible={sheet === "later"} onClose={() => setSheet(null)} onSchedule={schedule} busy={later.isPending} blocked={laterBlocked} />
      {secureOn ? <SecureSheet visible={sheet === "secure"} onClose={() => setSheet(null)} initial={secretSeed} onLink={(link) => putText(link)} /> : null}
    </KeyboardAvoidingView>
  );
}
