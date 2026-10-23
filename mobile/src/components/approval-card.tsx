import { Platform, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import type { Agent, Approval } from "@/api/types";
import { Badge, Button, Card, Icon } from "./ui";
import { timeAgo, timeLeft } from "@/lib/format";
import { colors, space } from "@/theme";

export const APPROVAL_STATUS: Record<Approval["status"], { label: string; tone: "ok" | "bad" | "neutral" | "brand" }> = {
  pending: { label: "Waiting", tone: "brand" }, sent: { label: "Approved and sent", tone: "ok" }, rejected: { label: "Rejected", tone: "neutral" },
  failed: { label: "Failed to send", tone: "bad" }, expired: { label: "Expired", tone: "neutral" },
};

export function ApprovalCard({ a, agent, onDecide, busy }: { a: Approval; agent?: Agent; onDecide?: (d: "approve" | "reject") => void; busy?: boolean }) {
  const st = APPROVAL_STATUS[a.status];
  const pending = a.status === "pending";
  const haptic = () => { if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}); };
  return (
    <Card style={{ gap: space.md, borderColor: pending ? "rgba(255,106,61,0.3)" : colors.line }}>
      <Pressable onPress={() => router.push({ pathname: "/approval/[id]", params: { id: a.id } })} accessibilityRole="button"
        accessibilityLabel={`${agent?.name ?? "An agent"} wants to send "${a.subject}" to ${a.to.join(", ")}. ${st.label}.`} accessibilityHint="Opens the full message to review or edit"
        style={({ pressed }) => ({ gap: space.md, opacity: pressed ? 0.75 : 1 })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: colors.brandSoft, alignItems: "center", justifyContent: "center" }}>
          <Icon name="cpu" size={15} color={colors.brand} />
        </View>
        <Text style={{ color: colors.fg, fontWeight: "600", fontSize: 15, flex: 1 }} numberOfLines={1}>{agent?.name ?? "Agent"}</Text>
        <Badge label={st.label} tone={st.tone} />
      </View>
      <View style={{ gap: 4 }}>
        <Text style={{ color: colors.subtle, fontSize: 13 }} numberOfLines={1}>To {a.to.join(", ")}{a.cc.length ? `, cc ${a.cc.join(", ")}` : ""}</Text>
        <Text style={{ color: colors.fg, fontSize: 16, fontWeight: "600" }} numberOfLines={2}>{a.subject || "(no subject)"}</Text>
        <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }} numberOfLines={4}>{a.text.replace(/\s+/g, " ").trim()}</Text>
      </View>
      <Text style={{ color: colors.subtle, fontSize: 12 }}>
        Asked {timeAgo(a.createdAt)}{pending ? `, ${timeLeft(a.expiresAt)}` : a.decidedBy ? `. Decided by ${a.decidedBy}` : ""}{a.note ? `. Note: ${a.note}` : ""}
      </Text>
      </Pressable>
      {pending && onDecide ? (
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button label="Approve" icon="check" style={{ flex: 1 }} loading={busy} testID={`approve-${a.id}`}
            onPress={() => { haptic(); onDecide("approve"); }} accessibilityHint="Sends the message as written" />
          <Button label="Reject" variant="secondary" icon="x" style={{ flex: 1 }} disabled={busy} testID={`reject-${a.id}`}
            onPress={() => { haptic(); onDecide("reject"); }} accessibilityHint="The message is not sent" />
        </View>
      ) : null}
    </Card>
  );
}
