import { useState } from "react";
import { Alert, FlatList, RefreshControl, Text, View } from "react-native";
import { Banner, Button, EmptyState, Loading, Segmented } from "@/components/ui";
import { ApprovalCard } from "@/components/approval-card";
import { useAgents, useApprovals, useDecide } from "@/lib/queries";
import { useOffline } from "@/lib/offline";
import { colors, space } from "@/theme";

export default function Approvals() {
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

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {offline ? <Banner text="Offline. Approve and reject need a connection." /> : null}
      <FlatList
        data={rows ?? []}
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
