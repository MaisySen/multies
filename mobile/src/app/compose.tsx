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
import { colors, radius, space } from "@/theme";

export default function Compose() {
  const params = useLocalSearchParams<{ replyTo?: string; forward?: string; to?: string; subject?: string; restore?: string; all?: string }>();
  // A message taken back with Undo comes back exactly as it was.
  const [parked] = useState(() => (params.restore ? takeParkedDraft() : null));
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
      setSubject(/^re:/i.test(subj) ? subj : `Re: ${subj}`);
      setText(quoteForReply(original.text ?? "", displayName(original.from), original.date));
    } else {
      setSubject(/^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`);
      setText(`\n\n---------- Forwarded message ----------\nFrom: ${displayName(original.from)} <${original.from.address}>\nSubject: ${subj}\n\n${original.text ?? ""}`);
    }
  }, [original, prefilled, params.replyTo, params.all, mailboxes]);

  const submit = async () => {
    setError(null);
    const toList = parseRecipients(to);
    const ccList = parseRecipients(cc);
    const bad = [...toList, ...ccList].find((a) => !EMAIL_RE.test(a));
    if (!from) return setError("You need an email address to send from. Tap Add an email address above.");
    if (!toList.length) return setError("Add at least one recipient.");
    if (bad) return setError(`"${bad}" doesn't look like an email address.`);
    if (!subject.trim() && !text.trim()) return setError("Write a subject or a message first.");
    // A gentle nudge, never a block: mail with no subject is more likely to go to spam.
    if (needsSubjectPrompt(subject) && Platform.OS !== "web" && !(await askAboutEmptySubject())) return subjectRef.current?.focus();
    // Undo send: close Compose now and post when the hold ends; the bar above the tabs offers Undo.
    const draft: HeldDraft = { mailboxId: from, to, cc, subject, text, inReplyToId: replyTo, forwardOf };
    const input = { mailboxId: from, to: toList, cc: ccList.length ? ccList : undefined, subject: subject.trim(), text, inReplyToId: replyTo };
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
        Alert.alert("Couldn't send", `${(e as Error).message || "Check your connection and try again."} Your message is back in Compose.`, [
          { text: "Open", onPress: () => router.push({ pathname: "/compose", params: { restore: "1" } }) },
        ]);
      },
    });
    trackHeld({ hold, draft, label: recipientsLabel([...toList, ...ccList]) });
    if (router.canGoBack()) router.back(); else router.replace("/inbox");
  };

  const discard = () => {
    if (!text.trim() && !to.trim()) return router.back();
    if (Platform.OS === "web") return router.back();
    Alert.alert("Discard this message?", "What you've written will be lost.", [
      { text: "Keep writing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => router.back() },
    ]);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{
        title: replyTo ? "Reply" : forwardOf ? "Forward" : "New message",
        headerLeft: () => <Button variant="ghost" label="Cancel" onPress={discard} />,
        headerRight: () => <Button label="Send" icon="send" onPress={submit} testID="send" style={{ minHeight: 38, paddingHorizontal: 14 }} />,
      }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
        {mailboxes.length > 1 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>From</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {mailboxes.map((m) => <Chip key={m.id} label={m.address} selected={from === m.id} onPress={() => setFrom(m.id)} />)}
            </View>
          </View>
        ) : mailboxes[0] ? <Text style={{ color: colors.subtle, fontSize: 14 }}>From {mailboxes[0].address}</Text> : overview.data ? (
          <View style={{ backgroundColor: colors.brandSoft, borderRadius: radius.md, padding: space.md, gap: space.sm }} testID="no-mailbox">
            <Text style={{ color: colors.fg, fontSize: 15 }}>{"You don't have an email address to send from yet. Connect your email or get a free address. It takes a minute."}</Text>
            <Button label="Add an email address" icon="at-sign" variant="secondary" testID="add-address" onPress={() => router.push("/email-setup")} style={{ alignSelf: "flex-start", minHeight: 36 }} />
          </View>
        ) : null}
        <Field label="To" testID="to" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="name@example.com.au" />
        {showCc ? <Field label="Cc" value={cc} onChangeText={setCc} autoCapitalize="none" keyboardType="email-address" /> : (
          <Button variant="ghost" label="Add Cc" icon="plus" onPress={() => setShowCc(true)} style={{ alignSelf: "flex-start", minHeight: 36 }} />
        )}
        <Field ref={subjectRef} label="Subject" testID="subject" value={subject} onChangeText={setSubject} />
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }} nativeID="body-label">Message</Text>
          <TextInput testID="body" value={text} onChangeText={setText} multiline accessibilityLabel="Message" accessibilityLabelledBy="body-label"
            placeholder="Write your message" placeholderTextColor={colors.subtle} selectionColor={colors.brand} textAlignVertical="top"
            style={{ minHeight: 220, color: colors.fg, fontSize: 16, lineHeight: 23, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface }} />
        </View>
        <Text style={{ color: colors.subtle, fontSize: 13 }}>{`After Send you have ${undoSeconds} seconds to undo. Change it in Settings.`}</Text>
        {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityRole="alert">{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
