/** Moved from (tabs)/approvals.tsx in M3 (1.10.11) so a stack screen can show it too (hidden tab routes do not open on Android). */
import { useState } from "react";
import { Alert, FlatList, RefreshControl, Text, View } from "react-native";
import { useCollapse } from "@/components/chrome";
import { Banner, Button, EmptyState, LargeTitle, Loading, Segmented } from "@/components/ui";
import { NotificationBell } from "@/components/notification-bell";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScreenHeader } from "@/components/m3-ui";

import { ApprovalCard } from "@/components/approval-card";
import { useAgents, useApprovals, useDecide } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { colors, space } from "@/theme";

/** The approvals list. On the tab it draws its own large title; stacked (/review) it uses the stack header with a back button. */
export function ApprovalsView({ stacked = false }: { stacked?: boolean }) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<"pending" | "decided">("pending");
  const pending = useApprovals("pending");
  const all = useApprovals("all");
  const agents = useAgents();
  const decide = useDecide();
  const offline = useOffline();
  const q = tab === "pending" ? pending : all;
  const rows = tab === "pending" ? q.data : q.data?.filter((a) => a.status !== "pending");

  const onDecide = (id: string, d: "approve" | "reject") =>
    decide.mutate({ id, decision: d }, { onError: (e) => Alert.alert(d === "approve" ? "Couldn't send it" : "Couldn't reject it", e.message) });

  const collapse = useCollapse(); // R34: large title folds on scroll
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }} testID="approvals-list">
      {stacked ? <ScreenHeader title="Approvals" /> : <LargeTitle title="Approvals" top={insets.top} collapsed={collapse.collapsed} right={<NotificationBell />} />}
      {offline ? <Banner text="Offline. Approve and reject need a connection." /> : null}
      <FlatList
        data={rows ?? []}
        {...collapse.scrollProps}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: space.xxl }}
        ListHeaderComponent={
          <View style={{ gap: space.md, marginBottom: space.sm }}>
            <Text style={{ color: colors.muted, fontSize: 14, lineHeight: 20 }}>Messages your agents want to send. Nothing leaves until someone approves it.</Text>
            <Segmented label="Approvals" value={tab} onChange={setTab}
              options={[{ id: "pending", label: `Waiting${pending.data?.length ? ` (${pending.data.length})` : ""}` }, { id: "decided", label: "Decided" }]} />
          </View>
        }
        renderItem={({ item }) => (
          <ApprovalCard a={item} agent={agents.data?.find((x) => x.id === item.agentId)}
            busy={decide.isPending && decide.variables?.id === item.id} onDecide={(d) => onDecide(item.id, d)} />
        )}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} tintColor={colors.brand} colors={[colors.brand]} />}
        ListEmptyComponent={q.isPending ? <Loading /> : q.error ? (
          <EmptyState icon="alert-circle" title="Couldn't load approvals" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />
        ) : (
          <EmptyState icon="check-circle" title={tab === "pending" ? "Nothing waiting" : "No decisions yet"}
            body={tab === "pending" ? "When an agent asks to send, it shows up here and on your lock screen." : "Approved and rejected messages show up here."} />
        )}
      />
    </View>
  );
}
