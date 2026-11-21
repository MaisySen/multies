/**
 * OPS1: shared bits for the console's Mail and deliverability page: the response types of /api/console/mail, the
 * calls that change something, the workspace cell, and SectionList (a list that is one section of a tab, under the
 * tab's own URL-synced list, so its paging and filter stay out of the address).
 */
import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { consoleApi, consoleGet, consoleKeys } from "@/web/lib/console-api";
import { Button } from "@/web/components/ui/button";
import { tableStyles as T } from "@/web/components/ui/misc";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { cn } from "@/web/lib/cn";
import { consoleTable, type DataColumn } from "./components/data-table";
import { EmptyRow, LoadError, WorkspaceLink } from "./components/format";

type Iso = string;

export interface MailDelivery { id: string; orgId: string; orgName: string | null; direction: "inbound" | "outbound"; status: string; provider: string; detail: string | null; createdAt: Iso }
export interface MailFailureRate { orgId: string; orgName: string | null; total: number; failed: number; bounced: number; complained: number; failureRate: number }
export interface MailDomain {
  id: string; orgId: string; orgName: string | null; name: string; status: "pending" | "verified" | "failed";
  sending: { status: "queued" | "error" | "verified" | "pending"; detail: string | null } | null;
  failingRecords: string[]; createdAt: Iso; verifiedAt: Iso | null; lastCheckedAt: Iso | null;
}
export interface MailSuppression { id: string; orgId: string; orgName: string | null; address: string; reason: "hard_bounce" | "complaint" | "manual"; detail: string | null; createdAt: Iso }
export interface MailQueuedSend { id: string; orgId: string; orgName: string | null; mailboxId: string; mailboxAddress: string | null; reason: string; recipients: number; forced: boolean; dueAt: Iso; createdAt: Iso }
export interface MailConnection {
  id: string; orgId: string; orgName: string | null; mailboxId: string; provider: string; email: string; imapHost: string; smtpHost: string;
  authKind: "password" | "oauth"; status: "active" | "syncing" | "auth_failed" | "error" | "paused"; lastError: string | null;
  initialDone: boolean; messagesSynced: number; lastSyncAt: Iso | null; nextSyncAt: Iso | null; createdAt: Iso;
}
export interface MailImport {
  id: string; orgId: string; orgName: string | null; mailboxId: string; provider: "gmail" | "outlook" | "imap"; sourceHost: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled"; messagesDone: number; messagesTotal: number | null; error: string | null;
  claimedAt: Iso | null; heartbeatAt: Iso | null; finishedAt: Iso | null; createdAt: Iso;
}

const enc = encodeURIComponent;
export const mailApi = {
  failureRates: (window: string) => consoleGet<{ items: MailFailureRate[] }>(`/console/mail/failure-rates?window=${enc(window)}&limit=10`),
  removeSuppression: (id: string, reason: string) => api.del<{ ok: true }>(`/console/mail/suppressions/${enc(id)}`, { reason }),
  recheckDomain: (id: string, reason: string) => api.post<{ ok: true; status: MailDomain["status"]; verified: boolean; failingRecords: string[] }>(`/console/mail/domains/${enc(id)}/recheck`, { reason }),
  forceSend: (id: string, reason: string) => api.post<{ ok: true; dueAt: string }>(`/console/mail/queued-sends/${enc(id)}/send`, { reason }),
  setSending: (orgId: string, enabled: boolean, reason: string) => api.put<{ ok: true; sending: boolean }>(`/console/mail/workspaces/${enc(orgId)}/sending`, { enabled, reason }),
};

/** A workspace name that opens it in the console, with a short id under it so two of one name can be told apart. */
export function Workspace({ id, name }: { id: string; name: string | null }) {
  return <WorkspaceLink id={id} name={name} hint={id.replace(/^org_/, "").slice(0, 8)} />;
}

/** Scrolls to the section with this id when the address names it (#mail-held), e.g. after an old ?tab= link. */
export function useScrollToSection(id: string) {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === `#${id}`) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hash, id]);
}

/**
 * A titled section with its own list (GET /api/console<path>), for a second list inside a tab. Paging, loading,
 * error and a one-line empty state are built in; `filter` renders beside the title.
 */
export function SectionList<R>({ id, title, path, query, columns, rowKey, empty, filter, testId }: {
  id: string; title: string; path: string; query: Record<string, string>; columns: DataColumn<R>[]; rowKey: (r: R) => string;
  empty: ReactNode; filter?: ReactNode; testId?: string;
}) {
  useScrollToSection(id);
  const list = useInfiniteQuery({
    queryKey: consoleKeys.list(path, query),
    queryFn: ({ pageParam }) => consoleApi.list<R>(path, { ...query, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section id={id} className="scroll-mt-20 space-y-2" aria-labelledby={`${id}-title`} data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-[13px] font-semibold">{title}</h2>
        {filter}
      </div>
      {list.isPending ? <SkeletonRows rows={3} label={`Loading ${title.toLowerCase()}`} /> : list.error ? (
        <LoadError error={list.error} what={title.toLowerCase()} retry={() => void list.refetch()} />
      ) : !rows.length ? <EmptyRow>{empty}</EmptyRow> : (
        <>
          <div className={T.wrap} tabIndex={0} role="region" aria-label={title}>
            <table className={consoleTable.table}>
              <thead className={T.head}>
                <tr>{columns.map((c) => <th key={c.key} className={cn(T.th, c.align === "right" && "text-right", c.secondary && consoleTable.secondary, c.className)}>{c.header}</th>)}</tr>
              </thead>
              <tbody className={T.body}>
                {rows.map((r) => (
                  <tr key={rowKey(r)} className={T.row}>
                    {columns.map((c) => <td key={c.key} className={cn(T.td, c.align === "right" && "text-right", c.secondary && consoleTable.secondary, c.className)}>{c.cell(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-subtle">
            <span className="tabular-nums">{rows.length} shown</span>
            {list.hasNextPage && <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load more</Button>}
          </div>
        </>
      )}
    </section>
  );
}
