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
    if (!subject.trim() && !text.trim() && !toolFiles.length) return setError(tr("m.compose.write_a_subject_or_a_message_first"));
    // A gentle nudge, never a block: mail with no subject is more likely to go to spam.
    if (needsSubjectPrompt(subject) && Platform.OS !== "web" && !(await askAboutEmptySubject())) return subjectRef.current?.focus();
    // Undo send: close Compose now and post when the hold ends; the bar above the tabs offers Undo.
    const draft: HeldDraft = { mailboxId: from, to, cc, subject, text, inReplyToId: replyTo, forwardOf, toolFiles: toolFiles.length ? toolFiles : undefined };
    const input = { mailboxId: from, to: toList, cc: ccList.length ? ccList : undefined, subject: subject.trim(), text, inReplyToId: replyTo, ...(toolFiles.length ? { toolFiles: toolFiles.map((f) => f.token) } : {}) };
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

  const discard = () => {
    if (!text.trim() && !to.trim() && !toolFiles.length) return router.back();
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
        ) : mailboxes[0] ? <Text style={{ color: colors.subtle, fontSize: 14 }}>From {mailboxes[0].address}</Text> : overview.data ? (
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
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>{toolFiles.length === 1 ? tr("m.compose.attachment") : `${toolFiles.length} attachments`}</Text>
            {toolFiles.map((f) => <FileChip key={f.token} name={f.name} size={f.bytes} onRemove={() => setToolFiles((cur) => cur.filter((x) => x.token !== f.token))} />)}
            <Text style={{ color: colors.subtle, fontSize: 12.5 }}>{tr("m.compose.tools_results_are_kept_for_an_hour_so_send_withi")}</Text>
          </View>
        ) : null}
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }} nativeID="body-label">{tr("m.compose.message")}</Text>
          <TextInput testID="body" value={text} onChangeText={setText} multiline accessibilityLabel={tr("m.compose.message")} accessibilityLabelledBy="body-label"
            placeholder={tr("m.compose.write_your_message")} placeholderTextColor={colors.subtle} selectionColor={colors.brand} textAlignVertical="top"
            style={{ minHeight: 220, color: colors.fg, fontSize: 16, lineHeight: 23, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface }} />
        </View>
        <Text style={{ color: colors.subtle, fontSize: 13 }}>{tr("m.compose.after_send_you_have_count_seconds_to_undo_change", { count: undoSeconds })}</Text>
        {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityRole="alert">{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
