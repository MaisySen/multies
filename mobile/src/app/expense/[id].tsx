/**
 * M2 (1.10.10): one expense: receipt fields as the server read them, its status, and Submit for approval or Withdraw
 * for your own. Editing fields, splits, approving and rebilling stay on the web for now (Open on the web).
 */
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Badge, Button, EmptyState, Loading } from "@/components/ui";
import { useExpense, useExpenseAction } from "@/lib/expenses-queries";
import { canSubmit, cents, expenseTitle, reading, statusOf } from "@/lib/expenses";
import { longDate } from "@/lib/format";
import { useSession } from "@/lib/session";
import { openWebPage } from "@/lib/web-open";
import { isApiError } from "@/api/transport";
import { colors, font, space } from "@/theme";

export default function ExpenseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { transport } = useSession();
  const q = useExpense(id);
  const act = useExpenseAction();
  const header = <Stack.Screen options={{ title: "Expense" }} />;
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading expense" rows={4} variant="task" /></View>;
  if (q.isError || !q.data) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="expense-error">{header}
        <EmptyState icon="alert-circle" title="Couldn't load this expense" body="Check your connection and try again."
          action={<Button label="Retry" onPress={() => q.refetch()} testID="expense-retry" />} />
      </View>
    );
  }
  const e = q.data;
  const st = statusOf(e.status);
  const run = (action: "submit" | "withdraw") => act.mutate({ id: e.id, action }, {
    onError: (err) => Alert.alert(action === "submit" ? "Couldn't submit" : "Couldn't withdraw", isApiError(err) ? err.message : "Check your connection and try again."),
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="expense-screen">{header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}>
        <View style={{ paddingTop: space.lg, gap: space.sm }}>
          <Text style={font.title} accessibilityRole="header" numberOfLines={2}>{expenseTitle(e)}</Text>
          <Text style={[font.headline, { color: colors.muted }]}>{cents(e.totalCents, e.currency ?? "AUD")}</Text>
          <View style={{ flexDirection: "row" }}><Badge label={st.label} tone={st.tone} /></View>
          {reading(e) ? <Text style={font.tiny} testID="expense-reading">Reading the receipt. Pull down to refresh.</Text> : null}
        </View>
        <InsetGroup>
          <GroupRow label="Date" value={e.spentOn ? longDate(e.spentOn) : "Not set"} />
          <GroupRow label="GST" value={typeof e.gstCents === "number" ? cents(e.gstCents, e.currency ?? "AUD") : "Not set"} />
          <GroupRow label="Category" value={e.category || "Not set"} />
          {e.userName && !e.own ? <GroupRow label="From" value={e.userName} /> : null}
          {e.note ? <GroupRow label="Note" sub={e.note} /> : null}
          {e.hasFile ? <GroupRow label="Receipt" value={e.fileName || "Attached"} /> : null}
        </InsetGroup>
        {e.status === "rejected" && e.rejectReason ? (
          <InsetGroup header="Why it was rejected"><GroupRow label={e.rejectReason} sub={e.decidedByName ? `By ${e.decidedByName}` : null} /></InsetGroup>
        ) : null}
        <View style={{ gap: space.sm, marginTop: space.xl }}>
          {canSubmit(e) ? <Button label="Submit for approval" loading={act.isPending} onPress={() => run("submit")} testID="expense-submit" /> : null}
          {e.own && e.status === "submitted" ? <Button label="Withdraw" variant="secondary" loading={act.isPending} onPress={() => run("withdraw")} testID="expense-withdraw" /> : null}
          {e.own && !canSubmit(e) && (e.status === "draft" || e.status === "rejected") && !reading(e)
            ? <Text style={font.tiny}>Add the total on the web, then submit it here.</Text> : null}
          <Button label="Open on the web" icon="external-link" variant="secondary" onPress={() => openWebPage(transport, "/app/contacts/invoices")} testID="expense-open-web"
            accessibilityHint="Edit fields, split costs or approve on the web" />
        </View>
      </ScrollView>
    </View>
  );
}
