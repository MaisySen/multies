import { useEffect, useMemo, useRef } from "react";
import { Alert, AppState, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CommandQueue, OFFLINE_SYNC_TEXT, apiExecutor, setCommandQueue, useWaitingCount, waitingLabel } from "@/lib/command-queue";
import { kv } from "@/lib/kv";
import { setOffline, useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { success, warning } from "@/lib/haptics";
import { Icon } from "./ui";
import { colors, radius, space } from "@/theme";

/** How often a waiting queue tries again while the app is open. */
const RETRY_MS = 20_000;

/**
 * R33: owns the offline command queue for a live session: sends waiting changes when the
 * connection comes back, when the app returns to the front, and every 20 seconds while any wait.
 */
export function useCommandQueueRunner() {
  const { api, mode, status, me } = useSession();
  const qc = useQueryClient();
  const offline = useOffline();
  const live = mode === "live" && status === "signedIn";
  // PRIV1b (P53): one queue per workspace; each command records its workspace and never runs in another.
  const ws = me ? me.organization?.id ?? "" : null;
  const queue = useMemo(() => (live ? new CommandQueue(kv(), apiExecutor(api), () => ws) : null), [live, api, ws]);
  useEffect(() => { setCommandQueue(queue); return () => setCommandQueue(null); }, [queue]);

  const flushRef = useRef<() => void>(() => {});
  useEffect(() => { flushRef.current = () => {
    if (!queue) return;
    void queue.load().then(() => {
      if (!queue.size) return;
      return queue.flush().then((r) => {
        if (r.sent) { setOffline(false); qc.invalidateQueries({ queryKey: ["tasks"] }); qc.invalidateQueries({ queryKey: ["messages"] }); success(); }
        if (r.rejected.length) {
          warning();
          const n = r.rejected.length;
          Alert.alert(n === 1 ? "One change couldn't be saved" : `${n} changes couldn't be saved`, r.rejected[0].error.message);
        }
      });
    }).catch(() => {});
  }; });

  useEffect(() => { if (!offline) flushRef.current(); }, [offline, queue]);
  useEffect(() => {
    const sub = AppState.addEventListener?.("change", (s) => { if (s === "active") flushRef.current(); });
    const timer = setInterval(() => flushRef.current(), RETRY_MS);
    return () => { sub?.remove(); clearInterval(timer); };
  }, []);
}

/** R33: "3 changes waiting" above the tab bar while edits wait to sync. */
export function SyncPill({ bottom = 64 }: { bottom?: number }) {
  const count = useWaitingCount();
  const offline = useOffline();
  const insets = useSafeAreaInsets();
  if (!count) return null;
  const label = waitingLabel(count);
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: bottom + insets.bottom, alignItems: "center" }}>
      <View accessible accessibilityLiveRegion="polite" accessibilityLabel={offline ? `${label}. ${OFFLINE_SYNC_TEXT}` : `${label}. Syncing now.`} testID="sync-pill"
        style={{ flexDirection: "row", alignItems: "center", gap: space.sm, backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line,
          paddingHorizontal: space.md, paddingVertical: 6, maxWidth: 340, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 3 }}>
        <Icon name={offline ? "wifi-off" : "refresh-cw"} size={14} color={offline ? colors.warn : colors.brand} />
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>{label}</Text>
          {offline ? <Text style={{ color: colors.subtle, fontSize: 12 }}>{OFFLINE_SYNC_TEXT}</Text> : null}
        </View>
      </View>
    </View>
  );
}
