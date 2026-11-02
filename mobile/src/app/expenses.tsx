/**
 * M2 (1.10.10): Expenses on the phone (web R106). Your expenses, and for approvers the ones waiting for them. Add a
 * receipt from the phone's files: the server reads it and fills in supplier, total and GST. Taking a photo with the
 * camera needs the next store build; until then, pick the photo from your files.
 */
import { useState } from "react";
import { Alert, FlatList, RefreshControl, Text, View } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow } from "@/components/grouped";
import { Badge, Button, EmptyState, Loading, Segmented } from "@/components/ui";
import { pickReceipt, useAddReceipt, useExpenses } from "@/lib/expenses-queries";
import { cents, expenseTitle, reading, statusOf } from "@/lib/expenses";
import { noAccess, notFoundErr } from "@/lib/contacts-queries";
import { dayLabel } from "@/lib/format";

import { colors, font, radius, space } from "@/theme";

export default function Expenses() {
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<"mine" | "approve">("mine");
  const q = useExpenses(view);
  const add = useAddReceipt();
  const header = <Stack.Screen options={{ title: "Expenses" }} />;
  const onAdd = async () => {
    const f = await pickReceipt().catch(() => null);
    if (!f) return;
    add.mutate(f, {
      onSuccess: (e) => router.push({ pathname: "/expense/[id]", params: { id: e.id } }),
      onError: (e) => Alert.alert("Couldn't add this receipt", e instanceof Error && e.message ? e.message : "Check your connection and try again."),
    });
  };
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading expenses" rows={6} variant="task" /></View>;
  if (q.isError) {
    const off = notFoundErr(q.error); const denied = noAccess(q.error);
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="expenses-error">{header}
        <EmptyState icon={off || denied ? "lock" : "alert-circle"}
          title={off ? "Expenses are off for this workspace" : denied ? "Expenses aren't open to you" : "Couldn't load expenses"}
          body={off ? "An admin can turn them on in Settings on the web." : denied ? "Ask an admin of this workspace for access." : "Check your connection and try again."}
          action={off || denied ? undefined : <Button label="Retry" onPress={() => q.refetch()} testID="expenses-retry" />} />
      </View>
    );
  }
  const data = q.data!;
  const addButton = <Button label="Add a receipt" icon="paperclip" loading={add.isPending} onPress={onAdd} testID="expenses-add" accessibilityHint="Pick a photo or PDF of a receipt from your files" />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="expenses-screen">{header}
      <FlatList
        data={data.expenses}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}
        ListHeaderComponent={
          <View style={{ gap: space.md, paddingTop: space.md, paddingBottom: space.sm }}>
            {data.canApprove ? (
              <Segmented label="Show" value={view} onChange={(v) => setView(v)}
                options={[{ id: "mine", label: "Mine" }, { id: "approve", label: data.waiting ? `To approve (${data.waiting})` : "To approve" }]} />
            ) : null}
            {view === "mine" ? addButton : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState icon="dollar-sign" title={view === "mine" ? "No expenses yet" : "Nothing to approve"}
            body={view === "mine" ? "Add a receipt and the supplier, total and GST fill in by themselves." : "Expenses people submit for approval show here."} />
        }
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: colors.line, marginLeft: space.md }} />}
        renderItem={({ item, index }) => {
          const st = statusOf(item.status);
          const sub = [item.spentOn ? dayLabel(item.spentOn) : null, view === "approve" ? item.userName : null, reading(item) ? "Reading receipt" : null].filter(Boolean).join(", ");
          const last = index === data.expenses.length - 1;
          return (
            <View style={{ backgroundColor: colors.surface, overflow: "hidden", borderTopLeftRadius: index === 0 ? radius.lg : 0, borderTopRightRadius: index === 0 ? radius.lg : 0,
              borderBottomLeftRadius: last ? radius.lg : 0, borderBottomRightRadius: last ? radius.lg : 0 }}>
              <GroupRow testID={`expense-${item.id}`} label={expenseTitle(item)} sub={sub || null}
                right={<View style={{ alignItems: "flex-end", gap: 4 }}><Text style={[font.body, { color: colors.fg, fontWeight: "600" }]}>{cents(item.totalCents, item.currency ?? "AUD")}</Text><Badge label={st.label} tone={st.tone} /></View>}
                onPress={() => router.push({ pathname: "/expense/[id]", params: { id: item.id } })} />
            </View>
          );
        }}
      />
    </View>
  );
}
