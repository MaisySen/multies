import { useEffect, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Button, Chip, Field } from "@/components/ui";
import { useOverview, useSend, useThread } from "@/lib/queries";
import { EMAIL_RE, displayName, parseRecipients, quoteForReply } from "@/lib/format";
import { colors, radius, space } from "@/theme";

export default function Compose() {
  const params = useLocalSearchParams<{ replyTo?: string; forward?: string; to?: string; subject?: string }>();
  const sourceId = params.replyTo ?? params.forward ?? "";
  const source = useThread(sourceId, !!sourceId);
  const original = sourceId ? source.data?.thread.find((m) => m.id === sourceId) ?? source.data?.message : undefined;
  const overview = useOverview();
  const mailboxes = useMemo(() => overview.data?.filter((m) => m.kind !== "agent") ?? [], [overview.data]);
  const send = useSend();
  const [idempotencyKey] = useState(() => Crypto.randomUUID());

  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState(params.to ?? "");
  const [cc, setCc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(params.subject ?? "");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [prefilled, setPrefilled] = useState(false);

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
      setSubject(/^re:/i.test(subj) ? subj : `Re: ${subj}`);
      setText(quoteForReply(original.text ?? "", displayName(original.from), original.date));
    } else {
      setSubject(/^fwd?:/i.test(subj) ? subj : `Fwd: ${subj}`);
      setText(`\n\n---------- Forwarded message ----------\nFrom: ${displayName(original.from)} <${original.from.address}>\nSubject: ${subj}\n\n${original.text ?? ""}`);
    }
  }, [original, prefilled, params.replyTo]);

  const submit = async () => {
    setError(null);
    const toList = parseRecipients(to);
    const ccList = parseRecipients(cc);
    const bad = [...toList, ...ccList].find((a) => !EMAIL_RE.test(a));
    if (!from) return setError("You need a mailbox to send from. Add one on the web first.");
    if (!toList.length) return setError("Add at least one recipient.");
    if (bad) return setError(`"${bad}" doesn't look like an email address.`);
    if (!subject.trim() && !text.trim()) return setError("Write a subject or a message first.");
    try {
      await send.mutateAsync({ input: { mailboxId: from, to: toList, cc: ccList.length ? ccList : undefined, subject: subject.trim(), text, inReplyToId: params.replyTo }, idempotencyKey });
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.back();
    } catch (e) {
      setError((e as Error).message);
    }
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
        title: params.replyTo ? "Reply" : params.forward ? "Forward" : "New message",
        headerLeft: () => <Button variant="ghost" label="Cancel" onPress={discard} />,
        headerRight: () => <Button label="Send" icon="send" onPress={submit} loading={send.isPending} testID="send" style={{ minHeight: 38, paddingHorizontal: 14 }} />,
      }} />
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
        {mailboxes.length > 1 ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }}>From</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
              {mailboxes.map((m) => <Chip key={m.id} label={m.address} selected={from === m.id} onPress={() => setFrom(m.id)} />)}
            </View>
          </View>
        ) : mailboxes[0] ? <Text style={{ color: colors.subtle, fontSize: 14 }}>From {mailboxes[0].address}</Text> : null}
        <Field label="To" testID="to" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" autoComplete="email" placeholder="name@example.com.au" />
        {showCc ? <Field label="Cc" value={cc} onChangeText={setCc} autoCapitalize="none" keyboardType="email-address" /> : (
          <Button variant="ghost" label="Add Cc" icon="plus" onPress={() => setShowCc(true)} style={{ alignSelf: "flex-start", minHeight: 36 }} />
        )}
        <Field label="Subject" testID="subject" value={subject} onChangeText={setSubject} />
        <View style={{ gap: 6 }}>
          <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }} nativeID="body-label">Message</Text>
          <TextInput testID="body" value={text} onChangeText={setText} multiline accessibilityLabel="Message" accessibilityLabelledBy="body-label"
            placeholder="Write your message" placeholderTextColor={colors.subtle} selectionColor={colors.brand} textAlignVertical="top"
            style={{ minHeight: 220, color: colors.fg, fontSize: 16, lineHeight: 23, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface }} />
        </View>
        {error ? <Text style={{ color: colors.bad, fontSize: 14 }} accessibilityRole="alert">{error}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
