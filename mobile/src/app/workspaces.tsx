import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, Icon, Loading } from "@/components/ui";
import { useSession } from "@/lib/session";
import { useWaitingCount } from "@/lib/command-queue";
import { success, warning } from "@/lib/haptics";
import type { WorkspaceSummary } from "@/api/types";
import { colors, font, radius, space, TOUCH } from "@/theme";

const ROLE: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/**
 * Multiws (27 Oct 2026): Settings, Workspace. Every workspace this person belongs to, the open one ticked; a tap
 * moves this phone there. Before this the row only showed the name, so someone who joined a second workspace and
 * signed in on the phone was stuck in whichever one the sign in opened.
 */
export default function Workspaces() {
  const { api, me, switchWorkspace } = useSession();
  const qc = useQueryClient();
  const waiting = useWaitingCount();
  const q = useQuery({ queryKey: ["workspaces"], queryFn: () => api.workspaces() });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = me?.organization?.id;

  const open = async (w: WorkspaceSummary) => {
    if (w.id === current || busy) return;
    if (waiting > 0) { warning(); setError("Some changes on this phone are still waiting to send. Connect to the internet, let them send, then switch."); return; }
    setBusy(w.id); setError(null);
    try {
      await switchWorkspace(w.id);
      qc.clear();
      success();
      router.back();
    } catch (e) {
      warning();
      setError(e instanceof Error && e.message ? e.message : "Couldn't open that workspace. Try again.");
      q.refetch();
    } finally { setBusy(null); }
  };

  if (q.isPending) return <Loading rows={3} label="Loading workspaces" />;
  if (q.error) return <EmptyState icon="alert-circle" title="Couldn't load your workspaces" body={q.error.message} action={<Button label="Try again" variant="secondary" onPress={() => q.refetch()} />} />;
  const list = q.data.workspaces;
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: colors.bg }} contentContainerStyle={{ padding: space.lg, gap: space.sm, paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); }} />} testID="workspaces">
      <Text style={[font.tiny, { textTransform: "uppercase", letterSpacing: 0.6, marginLeft: space.sm }]} accessibilityRole="header">
        {list.length === 1 ? "Your workspace" : `Your ${list.length} workspaces`}
      </Text>
      <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: "hidden" }}>
        {list.map((w, i) => {
          const on = w.id === current;
          return (
            <Pressable key={w.id} onPress={() => open(w)} disabled={!!busy} testID={`workspace-${w.id}`}
              accessibilityRole="button" accessibilityState={{ selected: on, busy: busy === w.id }} accessibilityLabel={`${w.name}, ${ROLE[w.role] ?? w.role}${on ? ", open now" : ""}`}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, minHeight: TOUCH + 12, backgroundColor: pressed ? colors.hover : colors.surface, borderTopWidth: i === 0 ? 0 : 0.5, borderTopColor: colors.line })}>
              <View style={{ width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.brand : colors.brandSoft }}>
                <Text style={{ color: on ? "#fff" : colors.brand, fontWeight: "700", fontSize: 14 }}>{w.name.slice(0, 1).toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: colors.fg, fontSize: 16, fontWeight: on ? "600" : "400" }} numberOfLines={1}>{w.name}</Text>
                <Text style={font.tiny} numberOfLines={1}>{ROLE[w.role] ?? w.role}{busy === w.id ? ", opening" : ""}</Text>
              </View>
              {on ? <Icon name="check" size={20} color={colors.brand} /> : null}
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={{ color: colors.bad, fontSize: 14, marginHorizontal: space.sm }} accessibilityLiveRegion="polite" testID="workspace-switch-error">{error}</Text> : null}
      <Text style={[font.small, { marginHorizontal: space.sm }]}>Tap a workspace to open it on this phone. Your other devices stay where they are. To make a new workspace or invite people, use Multies on the web.</Text>
    </ScrollView>
  );
}
