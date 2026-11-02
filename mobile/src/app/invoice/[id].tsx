/** M4: one invoice on the phone: amount, state, customer, lines, payments, and the customer's view link to share. */
import { Pressable, RefreshControl, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Icon, Loading } from "@/components/ui";
import { Problem, ScreenHeader } from "@/components/m3-ui";
import { m4s as st } from "@/components/m4-ui";
import { haptic, tick } from "@/lib/haptics";
import { openWeb } from "@/lib/web-open";
import { colors, font, radius, space } from "@/theme";
import { useInvoice } from "@/lib/m4-queries";
import { dueLine, money, qty, stateOf } from "@/lib/m4";
import { shortDate } from "@/lib/format";

export default function Invoice() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useInvoice(String(id ?? ""));
  const d = q.data;
  const header = <ScreenHeader title={d?.number ?? "Invoice"} />;
  if (q.isPending) return <View style={st.screen}>{header}<Loading label="Loading invoice" rows={4} variant="task" /></View>;
  if (q.isError || !d) return <View style={st.screen} testID="invoice-error">{header}<Problem q={q} what="This invoice" testID="invoice" /></View>;
  const s = stateOf(d.state);
  const due = dueLine(d, new Date().toISOString().slice(0, 10));
  const share = async () => {
    if (!d.viewUrl) return;
    tick();
    const r = await Share.share({ message: `${d.title} ${d.number ?? ""} for ${money(d.totalCents, d.currency)}: ${d.viewUrl}`, url: d.viewUrl }).catch(() => null);
    if (r && r.action === Share.sharedAction) haptic("success");
  };
  return (
    <View style={st.screen} testID="invoice-screen">
      {header}
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: insets.bottom + space.xxl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.brand} />}>
        <View style={[st.card, { padding: space.xl, alignItems: "center", gap: space.sm }]}>
          <Text style={font.small}>{d.state === "paid" ? "Paid in full" : d.state === "draft" ? "Draft total" : "Owing"}</Text>
          <Text style={{ fontSize: 40, fontWeight: "700", color: colors.fg, fontVariant: ["tabular-nums"] }} testID="invoice-amount">{money(d.state === "paid" || d.state === "draft" ? d.totalCents : d.owingCents, d.currency)}</Text>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "center" }}><Badge label={s.label} tone={s.tone} />{due ? <Text style={[font.small, { color: d.state === "overdue" ? colors.bad : colors.muted }]}>{due}</Text> : null}</View>
          <Text style={[font.body, { marginTop: space.sm }]}>{d.buyerName ?? "No customer yet"}</Text>
          {d.buyerEmail ? <Text style={font.small}>{d.buyerEmail}</Text> : null}
        </View>
        {d.viewUrl ? (
          <Pressable onPress={share} style={({ pressed }) => [sx.primary, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]} accessibilityRole="button" testID="invoice-share">
            <Icon name="send" size={18} color={colors.brandFg} /><Text style={sx.primaryText}>Share invoice link</Text>
          </Pressable>
        ) : null}
        <View style={st.card}>
          <Text style={sx.head}>Details</Text>
          <Line k="Issued" v={d.issueDate ? shortDate(`${d.issueDate}T00:00:00`) : "Not yet"} />
          <Line k="Due" v={d.dueDate ? shortDate(`${d.dueDate}T00:00:00`) : "Not set"} />
          {d.reference ? <Line k="Reference" v={d.reference} /> : null}
        </View>
        <View style={st.card}>
          <Text style={sx.head}>Items</Text>
          {d.lines.map((l) => (
            <View key={l.id} style={sx.line}>
              <View style={{ flex: 1 }}><Text style={font.body} numberOfLines={2}>{l.description}</Text><Text style={[font.small, { fontSize: 13 }]}>{qty(l.quantityMilli)} × {money(l.unitCents, d.currency)}</Text></View>
              <Text style={sx.num}>{money(l.totalCents, d.currency)}</Text>
            </View>
          ))}
          <Line k="Subtotal" v={money(d.subtotalCents, d.currency)} />
          <Line k="GST" v={money(d.gstCents, d.currency)} />
          <Line k="Total" v={money(d.totalCents, d.currency)} strong />
          {d.paidCents ? <Line k="Paid" v={`− ${money(d.paidCents, d.currency)}`} /> : null}
        </View>
        {d.payments.length ? (
          <View style={st.card}>
            <Text style={sx.head}>Payments</Text>
            {d.payments.map((p) => <Line key={p.id} k={`${shortDate(`${p.paidOn}T00:00:00`)}${p.method ? `, ${p.method}` : ""}`} v={money(p.amountCents, d.currency)} />)}
          </View>
        ) : null}
        <Pressable onPress={() => openWeb(`/app/contacts/invoices/${d.id}`)} style={sx.web} accessibilityRole="button" testID="invoice-edit-web">
          <Text style={{ color: colors.brand, fontSize: 15, fontWeight: "600" }}>{d.canManage ? "Edit, record a payment or send" : "Open full invoice"}</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Line({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return <View style={sx.kv}><Text style={[font.body, { color: colors.muted, flex: 1 }]}>{k}</Text><Text style={[sx.num, strong && { fontWeight: "700", fontSize: 18 }]}>{v}</Text></View>;
}

const sx = StyleSheet.create({
  head: { color: colors.subtle, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.4, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xs },
  kv: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 10, gap: space.md },
  line: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: 10, gap: space.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  num: { fontSize: 17, color: colors.fg, fontVariant: ["tabular-nums"] },
  primary: { flexDirection: "row", gap: space.sm, alignItems: "center", justifyContent: "center", minHeight: 52, borderRadius: radius.pill, backgroundColor: colors.brandFill },
  primaryText: { color: colors.brandFg, fontSize: 17, fontWeight: "600" },
  web: { alignItems: "center", paddingVertical: space.md },
});
