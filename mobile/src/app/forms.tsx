/**
 * M3 (1.10.11): Forms on the phone (was a web page). Each form with its responses count and last response; tap to read
 * the responses. Building a form stays on the web for now.
 */
import { RefreshControl, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { EmptyState, Loading } from "@/components/ui";
import { Problem, ScreenHeader } from "@/components/m3-ui";
import { useForms } from "@/lib/m3-queries";
import { timeAgo } from "@/lib/format";
import { colors, space } from "@/theme";

export function formSub(f: { enabled: boolean; submitCount: number; lastSubmitAt: string | null }, now = Date.now()): string {
  const n = `${f.submitCount} ${f.submitCount === 1 ? "response" : "responses"}`;
  if (!f.enabled) return `Closed · ${n}`;
  return f.lastSubmitAt ? `${n} · last ${timeAgo(f.lastSubmitAt, now)}` : n;
}

export default function Forms() {
  const insets = useSafeAreaInsets();
  const q = useForms();
  const header = <ScreenHeader title="Forms" />;
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading forms" rows={5} variant="task" /></View>;
  if (q.isError) return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="forms-error">{header}<Problem q={q} what="Forms" testID="forms" /></View>;
  const forms = q.data?.forms ?? [];
  if (!forms.length) {
    return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="forms-empty">{header}
      <EmptyState icon="list" title="No forms yet" body="Forms your team makes show here, with every response." /></View>;
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="forms-screen">{header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}>
        <InsetGroup>
          {forms.map((f) => (
            <GroupRow key={f.id} testID={`form-${f.id}`} label={f.name} sub={formSub(f)} icon="list" tile={f.enabled ? "indigo" : "gray"} chevron
              onPress={() => router.push({ pathname: "/form/[id]", params: { id: f.id, name: f.name, url: f.url } })} />
          ))}
        </InsetGroup>
      </ScrollView>
    </View>
  );
}
