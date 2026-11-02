/**
 * M3 (1.10.11): Automations on the phone (was a web page). Each rule in plain words, how often it ran, and a switch to
 * turn it on or off (admins; the switch moves back with a message if the server says no). Building rules stays on the web.
 */
import { Alert, RefreshControl, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupRow, InsetGroup } from "@/components/grouped";
import { EmptyState, Loading } from "@/components/ui";
import { Problem, ScreenHeader } from "@/components/m3-ui";
import { useAutomations, useToggleAutomation } from "@/lib/m3-queries";
import { automationLine } from "@/lib/m3";
import { noAccess } from "@/lib/contacts-queries";
import { timeAgo } from "@/lib/format";
import { colors, space } from "@/theme";

export default function Automations() {
  const insets = useSafeAreaInsets();
  const q = useAutomations();
  const toggle = useToggleAutomation();
  const header = <ScreenHeader title="Automations" />;
  if (q.isPending) return <View style={{ flex: 1, backgroundColor: colors.bg }}>{header}<Loading label="Loading automations" rows={5} variant="task" /></View>;
  if (q.isError) return <View style={{ flex: 1, backgroundColor: colors.bg }} testID="automations-error">{header}<Problem q={q} what="Automations" testID="automations" /></View>;
  const list = q.data?.automations ?? [];
  const flip = (id: string, enabled: boolean) => toggle.mutate({ id, enabled }, {
    onError: (e) => Alert.alert(enabled ? "Couldn't turn it on" : "Couldn't turn it off", noAccess(e) ? "Only admins of this workspace can change automations." : "Check your connection and try again."),
  });
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="automations-screen">{header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.xl }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.muted} />}>
        {!list.length ? <EmptyState icon="zap" title="No automations yet" body="Rules that do work for you, like making a task from a client email, show here." /> : (
          <InsetGroup footer="Turn a rule off here to pause it. Agent runs shows what your agents did.">
            {list.map((a) => (
              <GroupRow key={a.id} testID={`automation-${a.id}`} label={a.name} icon="zap" tile={a.enabled ? "purple" : "gray"}
                sub={`${automationLine(a)}${a.lastError ? " · last run failed" : a.lastRunAt ? ` · ran ${timeAgo(a.lastRunAt)}` : ""}`}
                toggle={{ value: a.enabled, onChange: (v) => flip(a.id, v) }} />
            ))}
          </InsetGroup>
        )}
        <InsetGroup>
          <GroupRow label="Agent runs" icon="bot" tile="purple" chevron onPress={() => router.push("/runs")} testID="automations-runs" />
        </InsetGroup>
      </ScrollView>
    </View>
  );
}
