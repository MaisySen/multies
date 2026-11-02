/**
 * M4: Invoices on the phone (was a web page). What is owed and overdue at a glance, filters, every invoice with its
 * state and due date, pull to refresh. Making and editing invoices stays on the web for now.
 */
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Badge, Chip, EmptyState, Loading } from "@/components/ui";
import { Problem, ScreenHeader } from "@/components/m3-ui";
import { m4s, TintIcon } from "@/components/m4-ui";
import { tick } from "@/lib/haptics";
import { colors, font, space } from "@/theme";
import { useInvoices } from "@/lib/m4-queries";
import { dueLine, INVOICE_FILTERS, money, stateOf, type InvoiceDoc } from "@/lib/m4";

export default function Invoices() {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<string>("open");
  const q = useInvoices(filter);
  const today = new Date().toISOString().slice(0, 10);
  const header = <ScreenHeader title="Invoices" />;
  if (q.isError) return <View style={st.screen} testID="invoices-error">{header}<Problem q={q} what="Invoices" testID="invoices" /></View>;
  const items = q.data?.items ?? [];
  const cur = items[0]?.currency ?? "AUD";
  return (
    <View style={st.screen} testID="invoices-screen">
      {header}
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: insets.bottom + space.xxl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { tick(); q.refetch(); }} tintColor={colors.brand} />}>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Total label="Owed to you" value={q.data ? money(q.data.totals.openCents, cur) : null} icon="dollar-sign" color={colors.brand} />
          <Total label="Overdue" value={q.data ? money(q.data.totals.overdueCents, cur) : null} icon="overdue" color={q.data?.totals.overdueCents ? colors.bad : colors.ok} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {INVOICE_FILTERS.map((f) => <Chip key={f.id} label={f.label} selected={filter === f.id} onPress={() => { tick(); setFilter(f.id); }} />)}
        </ScrollView>
        {q.isPending ? <Loading label="Loading invoices" rows={5} variant="task" /> : !items.length ? (
          <EmptyState icon="file-text" title={filter ? "Nothing here" : "No invoices yet"} body={filter ? "No invoices match this filter." : "Invoices you make on the web show here with what is owed."} />
        ) : (
          <View style={st.card}>
            {items.map((d, i) => <InvoiceRow key={d.id} d={d} today={today} last={i === items.length - 1} />)}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Total({ label, value, icon, color }: { label: string; value: string | null; icon: "dollar-sign" | "overdue"; color: string }) {
  return (
    <View style={[st.card, { flex: 1, padding: space.lg, gap: space.sm }]} accessible accessibilityLabel={`${label}, ${value ?? "loading"}`}>
      <TintIcon icon={icon} color={color} size={36} />
      <Text style={{ fontSize: 22, fontWeight: "700", color: colors.fg, fontVariant: ["tabular-nums"] }} numberOfLines={1} adjustsFontSizeToFit>{value ?? " "}</Text>
      <Text style={font.small}>{label}</Text>
    </View>
  );
}

function InvoiceRow({ d, today, last }: { d: InvoiceDoc; today: string; last: boolean }) {
  const s = stateOf(d.state);
  const due = dueLine(d, today);
  return (
    <Pressable onPress={() => { tick(); router.push(`/invoice/${d.id}` as never); }} testID={`invoice-${d.id}`} accessibilityRole="button"
      accessibilityLabel={`${d.number ?? "Draft"}, ${d.buyerName ?? "no customer"}, ${money(d.totalCents, d.currency)}, ${s.label}${due ? `, ${due}` : ""}`}
      style={({ pressed }) => [st.row, !last && st.sep, pressed && { backgroundColor: colors.hover }]}>
      <TintIcon icon="file-text" color={s.tone === "bad" ? colors.bad : s.tone === "ok" ? colors.ok : colors.brand} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={font.headline} numberOfLines={1}>{d.buyerName ?? "No customer yet"}</Text>
        <Text style={[font.small, { fontSize: 13 }]} numberOfLines={1}>{d.number ?? "Draft"}{due ? `  ·  ${due}` : ""}</Text>
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        <Text style={{ fontSize: 17, fontWeight: "600", color: colors.fg, fontVariant: ["tabular-nums"] }}>{money(d.owingCents && d.state !== "paid" ? d.owingCents : d.totalCents, d.currency)}</Text>
        <Badge label={s.label} tone={s.tone} />
      </View>
    </Pressable>
  );
}

const st = m4s;
