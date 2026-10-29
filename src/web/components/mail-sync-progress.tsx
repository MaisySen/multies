import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { num } from "@/web/lib/format";
import { showError } from "@/web/lib/show-error";
import { Meter } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { connectionsKey } from "@/web/components/connect-mailbox";
import type { ConnectionView } from "@/shared/mail-connect";

type Backfill = NonNullable<ConnectionView["backfill"]>;

/** R57: the words for where copying the whole mailbox stands. */
export function backfillLine(b: Backfill): string {
  if (b.done) return "All mail synced";
  const of = b.counted ? `${num(b.synced)} of ${num(b.total)}` : `${num(b.synced)} so far`;
  if (b.paused) return `Older mail paused at ${of}. New mail still comes in.`;
  if (b.wait) return `Synced ${of}. Older mail picks up again within a day.`;
  return `Syncing your mailbox: ${of} (older mail keeps coming in)`;
}

/**
 * R57: progress of the full mailbox sync, on the connection screen and at the top of Mail. Reading is never blocked;
 * Pause holds older mail only (new mail keeps coming).
 */
export function MailboxSyncProgress({ c, compact = false }: { c: ConnectionView; compact?: boolean }) {
  const qc = useQueryClient();
  const b = c.backfill;
  const toggle = useMutation({
    mutationFn: (paused: boolean) => api.post(`/connections/${c.id}/backfill`, { paused }),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionsKey }),
    onError: showError,
  });
  if (!b || c.sample) return null;
  if (b.done && compact) return null;
  return (
    <div className={compact ? "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5" : "mt-2 space-y-1.5"} data-testid="sync-progress">
      <p className="min-w-0 flex-1 text-[13px] text-muted" aria-live="polite">
        {compact && <span className="font-medium text-fg">{c.email}: </span>}
        <span data-testid="sync-progress-text">{backfillLine(b)}</span>
      </p>
      {!b.done && (
        <div className={compact ? "flex w-full items-center gap-2 sm:w-auto" : "flex items-center gap-2"}>
          <Meter value={b.synced} max={Math.max(b.total, b.synced, 1)} label={`${num(b.synced)} of ${num(b.total)} messages synced`} className={compact ? "w-full sm:w-40" : "max-w-xs"} />
          <Button size="sm" variant="ghost" loading={toggle.isPending} onClick={() => toggle.mutate(!b.paused)} data-testid="sync-progress-toggle" aria-label={b.paused ? `Resume syncing older mail for ${c.email}` : `Pause syncing older mail for ${c.email}`}>
            {b.paused ? "Resume" : "Pause"}
          </Button>
        </div>
      )}
    </div>
  );
}

/** R57: one slim line per connected mailbox still syncing, at the top of Mail; refreshes while it runs, gone when done. */
export function MailSyncBanner() {
  const q = useQuery({
    queryKey: connectionsKey,
    queryFn: () => api.get<{ connections: ConnectionView[] }>("/connections"),
    retry: false,
    refetchInterval: (query) => ((query.state.data as { connections?: ConnectionView[] } | undefined)?.connections ?? []).some((c) => c.backfill && !c.backfill.done && !c.backfill.paused && !c.backfill.wait) ? 20_000 : false,
  });
  const syncing = (q.data?.connections ?? []).filter((c) => c.backfill && !c.backfill.done && !c.sample && c.status !== "paused");
  if (!syncing.length) return null;
  return (
    <div className="space-y-1 border-b border-line bg-brand-soft/40 px-4 py-2" data-testid="mail-sync-banner">
      {syncing.map((c) => <MailboxSyncProgress key={c.id} c={c} compact />)}
    </div>
  );
}
