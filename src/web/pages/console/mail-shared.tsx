/**
 * OPS1: shared bits for the console's Mail and deliverability page: the response types of /api/console/mail, the
 * calls that change something, tabs kept in ?tab=, and small cells (workspace link, time, status badge).
 */
import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "@/web/lib/api";
import { fullDate, timeAgo } from "@/web/lib/format";
import { Badge } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import type { Permission } from "@/shared/operator-permissions";
import { usePermission } from "./guard";

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
  failureRates: (window: string) => api.get<{ items: MailFailureRate[] }>(`/console/mail/failure-rates?window=${enc(window)}&limit=10`),
  removeSuppression: (id: string, reason: string) => api.del<{ ok: true }>(`/console/mail/suppressions/${enc(id)}`, { reason }),
  recheckDomain: (id: string, reason: string) => api.post<{ ok: true; status: MailDomain["status"]; verified: boolean; failingRecords: string[] }>(`/console/mail/domains/${enc(id)}/recheck`, { reason }),
  forceSend: (id: string, reason: string) => api.post<{ ok: true; dueAt: string }>(`/console/mail/queued-sends/${enc(id)}/send`, { reason }),
  setSending: (orgId: string, enabled: boolean, reason: string) => api.put<{ ok: true; sending: boolean }>(`/console/mail/workspaces/${enc(orgId)}/sending`, { enabled, reason }),
};

export type Tone = "neutral" | "ok" | "warn" | "bad" | "brand";

/** A workspace name that opens the workspace in the console. */
export function WorkspaceLink({ id, name }: { id: string; name: string | null }) {
  return <Link to={`/console/workspaces/${enc(id)}`} className="font-medium text-fg hover:underline">{name || id}</Link>;
}

/** Relative time with the exact time on hover. */
export function When({ at, empty = "Never" }: { at: Iso | null; empty?: string }) {
  if (!at) return <span className="text-subtle">{empty}</span>;
  return <span className="whitespace-nowrap text-muted" title={fullDate(at)}>{timeAgo(at)}</span>;
}

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Badge tone={tone} dot>{children}</Badge>;
}

/** "auth_failed" reads as "Auth failed". */
export const plain = (s: string) => {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export interface MailTab { id: string; label: string; permission?: Permission }

/** The current tab from ?tab= (the first tab when there is none or it is unknown). */
export function useMailTab(tabs: MailTab[]): string {
  const [params] = useSearchParams();
  const t = params.get("tab");
  return tabs.find((x) => x.id === t)?.id ?? tabs[0]!.id;
}

function TabLink({ tab, first, current }: { tab: MailTab; first: boolean; current: boolean }) {
  const allowed = usePermission(tab.permission ?? "mail.read");
  if (!allowed) return null;
  // A tab change starts that tab's list from its own default filters.
  return (
    <li>
      <Link to={first ? "/console/mail" : `/console/mail?tab=${tab.id}`} replace aria-current={current ? "page" : undefined} data-testid={`console-mail-tab-${tab.id}`}
        className={cn("-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors", current ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
        {tab.label}
      </Link>
    </li>
  );
}

/** Tabs for a list page, kept in ?tab= so a link opens the same tab. Looks like the console's DetailTabs. */
export function MailTabs({ tabs }: { tabs: MailTab[] }) {
  const current = useMailTab(tabs);
  return (
    <nav aria-label="Sections" className="mb-5 overflow-x-auto border-b border-line">
      <ul className="flex min-w-max gap-1">
        {tabs.map((t, i) => <TabLink key={t.id} tab={t} first={i === 0} current={current === t.id} />)}
      </ul>
    </nav>
  );
}
