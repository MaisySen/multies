import { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Badge, Button, EmptyState, Field, Loading } from "@/components/ui";
import { APPROVAL_STATUS } from "@/components/approval-card";
import { LinkedText } from "@/components/linked-text";
import { useAgents, useApprovals, useDecide } from "@/lib/queries";
import { longDate, timeLeft } from "@/lib/format";
import { colors, font, radius, space } from "@/theme";

export default function ApprovalDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const all = useApprovals("all");
  const agents = useAgents();
  const decide = useDecide();
  const a = all.data?.find((x) => x.id === id);
  const agent = agents.data?.find((x) => x.id === a?.agentId);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);

  useEffect(() => { if (a) { setSubject(a.subject); setText(a.text); } }, [a?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (all.isPending) return <Loading />;
  if (!a) return <EmptyState icon="alert-circle" title="This request is gone" body="It may have expired or been decided on another device." />;

  const pending = a.status === "pending";
  const edited = subject !== a.subject || text !== a.text;
  const st = APPROVAL_STATUS[a.status];
  const run = (decision: "approve" | "reject") =>
    decide.mutate({ id: a.id, decision, subject: edited ? subject : undefined, text: edited ? text : undefined, note: note.trim() || undefined }, {
      onSuccess: () => router.back(),
      onError: (e) => Alert.alert("That didn't work", e.message),
    });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
          <Badge label={agent?.name ?? "Agent"} tone="brand" icon="cpu" />
          <Badge label={st.label} tone={st.tone} />
          {pending ? <Text style={font.tiny}>{timeLeft(a.expiresAt)}</Text> : null}
        </View>
        <View style={{ gap: 4 }}>
          <Text style={font.small}>To: {a.to.join(", ")}</Text>
          {a.cc.length ? <Text style={font.small}>Cc: {a.cc.join(", ")}</Text> : null}
          <Text style={font.tiny}>Asked {longDate(a.createdAt)}{agent ? ` by ${agent.address}` : ""}</Text>
        </View>
        {pending ? (
          <>
            <Field label="Subject" value={subject} onChangeText={setSubject} testID="approval-subject" />
            <View style={{ gap: 6 }}>
              <Text style={{ color: colors.muted, fontSize: 14, fontWeight: "500" }} nativeID="approval-body-label">Message</Text>
              <TextInput value={text} onChangeText={setText} multiline accessibilityLabel="Message" accessibilityLabelledBy="approval-body-label" textAlignVertical="top" selectionColor={colors.brand}
                style={{ minHeight: 200, color: colors.fg, fontSize: 16, lineHeight: 23, padding: space.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface }} />
              <Text style={font.tiny}>{edited ? "Your edits go out instead of the agent's version." : "You can edit before you approve."}</Text>
            </View>
            {rejecting ? <Field label="Note for the agent (optional)" value={note} onChangeText={setNote} placeholder="Why it shouldn't go" /> : null}
            <Button label={edited ? "Approve with my edits" : "Approve and send"} icon="check" onPress={() => run("approve")} loading={decide.isPending && decide.variables?.decision === "approve"} testID="approve" />
            <Button label={rejecting ? "Reject this message" : "Reject"} variant={rejecting ? "danger" : "secondary"} icon="x"
              onPress={() => (rejecting ? run("reject") : setRejecting(true))} loading={decide.isPending && decide.variables?.decision === "reject"} testID="reject" />
          </>
        ) : (
          <View style={{ gap: space.md }}>
            <Text style={[font.heading, { fontSize: 18 }]}>{a.subject}</Text>
            <Text style={font.body} selectable><LinkedText text={a.text} /></Text>
            {a.error ? <Text style={{ color: colors.bad }}>{a.error}</Text> : null}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
