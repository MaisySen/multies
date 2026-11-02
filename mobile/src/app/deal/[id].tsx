/**
 * M2 (1.10.10): one deal: value, stage, chance, expected close, contact and company, with Move to another stage
 * (PATCH /api/deals/:id). The deal comes from the Deals list the server sent.
 */
import { useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionSheet } from "@/components/action-sheet";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { Button, EmptyState, Loading } from "@/components/ui";
import { useDeals, useMoveDeal } from "@/lib/deals-queries";
import { money, STAGE_LABEL, STAGE_ORDER, type DealStage } from "@/lib/deals";
import { longDate } from "@/lib/format";
import { isApiError } from "@/api/transport";
import { colors, font, space } from "@/theme";

export default function DealScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const q = useDeals();
  const move = useMoveDeal();
  const [picking, setPicking] = useState(false);
  const d = q.data?.deals.find((x) => x.id === id);
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}><Stack.Screen options={{ title: "Deal" }} /><Loading label="Loading deal" rows={4} variant="task" /></View>;
  if (q.isError || !d) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }} testID="deal-missing"><Stack.Screen options={{ title: "Deal" }} />
        <EmptyState icon="alert-circle" title={q.isError ? "Couldn't load this deal" : "This deal isn't here"} body={q.isError ? "Check your connection and try again." : "It may have been deleted."}
          action={<Button label="Retry" onPress={() => q.refetch()} testID="deal-retry" />} />
      </View>
    );
  }
  const onPick = (stage: string) => {
    setPicking(false);
    if (stage === d.stage) return;
    move.mutate({ id: d.id, stage: stage as DealStage }, {
      onError: (e) => Alert.alert("Couldn't move this deal", isApiError(e) && e.status === 403 ? "You don't have permission to change deals." : "Check your connection and try again."),
    });
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="deal-screen">
      <Stack.Screen options={{ title: "Deal" }} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}>
        <View style={{ paddingTop: space.lg, gap: space.xs }}>
          <Text style={font.title} accessibilityRole="header" numberOfLines={3}>{d.title}</Text>
          <Text style={[font.headline, { color: colors.muted }]}>{money(d.value, d.currency)}</Text>
        </View>
        <InsetGroup>
          <GroupRow label="Stage" value={STAGE_LABEL[d.stage] ?? d.stage} testID="deal-stage" />
          {typeof d.probability === "number" ? <GroupRow label="Chance to win" value={`${d.probability}%`} /> : null}
          {d.expectedClose ? <GroupRow label="Expected close" value={longDate(d.expectedClose)} /> : null}
          {d.closedAt ? <GroupRow label="Closed" value={longDate(d.closedAt)} /> : null}
          {d.closeReason ? <GroupRow label="Reason" sub={d.closeReason} /> : null}
        </InsetGroup>
        {d.contact || d.company ? (
          <InsetGroup header="People">
            {d.contact ? <GroupRow label={d.contact.name || d.contact.email || "Contact"} icon="user" tile="teal" testID="deal-contact"
              onPress={() => router.push({ pathname: "/contact/[id]", params: { id: d.contact!.id } })} /> : null}
            {d.company ? <GroupRow label={d.company.name} icon="briefcase" tile="gray" /> : null}
          </InsetGroup>
        ) : null}
        <View style={{ marginTop: space.xl }}>
          <Button label="Move to another stage" icon="move" variant="secondary" loading={move.isPending} onPress={() => setPicking(true)} testID="deal-move" />
        </View>
      </ScrollView>
      <ActionSheet visible={picking} title="Move to" onClose={() => setPicking(false)} testID="deal-stage-sheet"
        options={STAGE_ORDER.map((s) => ({ id: s, label: STAGE_LABEL[s], selected: s === d.stage }))} onSelect={onPick} />
    </View>
  );
}
