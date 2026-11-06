import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenHeader, ProgressBar, Problem } from "@/components/m3-ui";
import { InsetGroup } from "@/components/grouped";
import { Badge, Loading } from "@/components/ui";
import { colors, font, lh, space } from "@/theme";
import { currentLocale, tr } from "@/i18n";
import { planStatusLine, usageRows } from "@/lib/mpar2";
import { useBilling } from "@/lib/mpar2-queries";

/**
 * MPAR2: Settings > Plan and billing, read only. The plan, its state and what the workspace uses, from GET
 * /api/billing. Nothing here buys, links to buying or changes anything (App Store 3.1.1): plan changes are made on the
 * web by a workspace owner or admin, and the screen only says so.
 */
export default function BillingScreen() {
  const q = useBilling();
  const b = q.data;
  const status = b ? planStatusLine(b, currentLocale()) : null;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="billing-screen">
      <ScreenHeader title={tr("m.billing.title")} back={tr("nav.settings")} />
      {q.isLoading ? <Loading label={tr("m.billing.loading")} rows={4} variant="task" /> : q.error && !b ? <Problem q={q} what={tr("m.billing.what")} testID="billing-problem" /> : b ? (
        <ScrollView contentContainerStyle={{ paddingBottom: space.xxl }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { void q.refetch(); }} />}>
          <View style={st.card} testID="billing-plan">
            <Text style={st.kicker}>{tr("m.billing.current_plan")}</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" }}>
              <Text style={st.plan}>{b.plan.name}</Text>
              {b.interval ? <Badge label={b.interval === "year" ? tr("m.billing.yearly") : tr("m.billing.monthly")} tone="neutral" /> : null}
            </View>
            {status ? <Text style={[st.status, { color: status.tone === "bad" ? colors.bad : status.tone === "warn" ? colors.warn : colors.muted }]} testID="billing-status">{status.text}</Text> : null}
          </View>
          <InsetGroup header={tr("m.billing.usage")} footer={tr("m.billing.read_only_note")} testID="billing-usage">
            {usageRows(b).map((r) => (
              <View key={r.id} style={st.meter} accessible accessibilityLabel={`${r.label}, ${r.text}`} testID={`billing-${r.id}`}>
                <View style={st.meterTop}><Text style={st.meterLabel}>{r.label}</Text><Text style={st.meterText}>{r.text}</Text></View>
                <ProgressBar value={r.ratio * 100} tone={r.ratio >= 0.9 ? "bad" : r.ratio >= 0.75 ? "warn" : "brand"} />
              </View>
            ))}
          </InsetGroup>
          <Text style={st.note} testID="billing-note">{tr("m.billing.manage_note")}</Text>
        </ScrollView>
      ) : (
        <Text style={st.note}>{tr("m.billing.manage_note")}</Text>
      )}
    </View>
  );
}
const st = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: 14, marginHorizontal: space.lg, marginTop: space.lg, padding: space.lg, gap: 6 },
  kicker: { ...font.small, fontSize: 13, lineHeight: lh(18) },
  plan: { ...font.title, fontSize: 26 },
  status: { fontSize: 15, lineHeight: lh(20) },
  note: { ...font.small, marginHorizontal: space.lg, marginTop: space.lg },
  meter: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: 8 },
  meterTop: { flexDirection: "row", justifyContent: "space-between", gap: space.md, flexWrap: "wrap" },
  meterLabel: { color: colors.fg, fontSize: 16, lineHeight: lh(21) },
  meterText: { color: colors.muted, fontSize: 15, lineHeight: lh(20), fontVariant: ["tabular-nums"] },
});
