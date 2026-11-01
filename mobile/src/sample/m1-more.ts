/**
 * M1 (1.10.9): the sample workspace's Mail merge, Mail archive and Sync, in the server's shapes. In memory only.
 * The sample person is an admin, so every action shows; tests swap in member answers with a wrapping transport.
 */
import { ApiError } from "@/api/errors";
import type { JourneyView, MergeListView, NewsletterView } from "@/lib/mail-merge";
import type { ArchiveHit, LegalHoldView, MailCaseView, RetentionView } from "@/lib/mail-archive";
import type { AppPasswordView } from "@/lib/dav-sync";

export interface M1MoreState {
  newsletters: NewsletterView[]; lists: MergeListView[]; journeys: JourneyView[];
  policy: RetentionView; holds: LegalHoldView[]; cases: MailCaseView[]; mail: ArchiveHit[];
  passwords: AppPasswordView[]; seq: number;
}

export function sampleM1More(now: number): M1MoreState {
  const day = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  const stats = (total: number, sent: number, opened: number, clicked: number) => ({ total, sent, failed: 0, skipped: 0, opened, clicked, unsubscribed: Math.round(sent / 80), bounced: Math.round(sent / 120) });
  const nl = (id: string, name: string, status: NewsletterView["status"], st: NewsletterView["stats"], ago: number, extra: Partial<NewsletterView> = {}): NewsletterView => ({
    id, name, subject: name, status, listId: "lst_s1", listName: "Customers", mailboxId: "mbx_s1", scheduledAt: null, sentAt: null, error: null, stats: st, updatedAt: iso(now - ago * day), canSend: true, ...extra,
  });
  return {
    newsletters: [
      nl("nl_s1", "November specials", "sending", stats(420, 180, 61, 14), 0),
      nl("nl_s2", "Spring site update", "sent", stats(388, 388, 171, 42), 9, { sentAt: iso(now - 9 * day) }),
      nl("nl_s3", "Holiday hours", "scheduled", stats(0, 0, 0, 0), 1, { scheduledAt: iso(now + 3 * day) }),
      nl("nl_s4", "Price changes", "draft", stats(0, 0, 0, 0), 2),
    ],
    lists: [
      { id: "lst_s1", name: "Customers", description: null, visibility: "workspace", mine: true, canSend: true, subscribed: 420, pending: 6, unsubscribed: 11, bounced: 2, updatedAt: iso(now - day) },
      { id: "lst_s2", name: "Trade partners", description: null, visibility: "private", mine: true, canSend: true, subscribed: 38, pending: 0, unsubscribed: 1, bounced: 0, updatedAt: iso(now - 4 * day) },
    ],
    journeys: [
      { id: "jr_s1", name: "Welcome series", status: "active", listId: "lst_s1", listName: "Customers", mailboxId: "mbx_s1", steps: [{}, {}, {}], enrolled: 64, updatedAt: iso(now - 2 * day), canSend: true, active: 12,
        stepStats: [{ name: "Welcome", total: 64, sent: 64, opened: 40, clicked: 9, unsubscribed: 1 }, { name: "How we work", total: 52, sent: 52, opened: 28, clicked: 6, unsubscribed: 0 }, { name: "A thank you", total: 40, sent: 40, opened: 19, clicked: 3, unsubscribed: 0 }] },
      { id: "jr_s2", name: "Quote follow up", status: "paused", listId: "lst_s2", listName: "Trade partners", mailboxId: "mbx_s1", steps: [{}, {}], enrolled: 9, updatedAt: iso(now - 6 * day), canSend: true, active: 3,
        stepStats: [{ name: "Thanks for asking", total: 9, sent: 9, opened: 7, clicked: 2, unsubscribed: 0 }] },
    ],
    policy: { enabled: true, keepYears: 7, startsAt: iso(now - 30 * day), lastRunAt: iso(now - day), lastRunDeleted: 0, totalDeleted: 12, timeZone: "Australia/Sydney", canManage: true, activeHolds: 1 },
    holds: [
      { id: "hold_s1", kind: "mailbox", targetId: "mbx_s1", targetLabel: "accounts@harbourbuild.com.au", name: "Supplier dispute", note: null, createdBy: "Sam Carter", createdAt: iso(now - 20 * day), releasedAt: null, releasedBy: null },
      { id: "hold_s2", kind: "person", targetId: "usr_s2", targetLabel: "Alex Lee", name: "Old audit", note: null, createdBy: "Sam Carter", createdAt: iso(now - 200 * day), releasedAt: iso(now - 100 * day), releasedBy: "Sam Carter" },
    ],
    cases: [{ id: "case_s1", name: "Supplier dispute mail", filters: { q: "invoice" }, createdBy: "Sam Carter", createdAt: iso(now - 19 * day), lastExportedAt: iso(now - 18 * day), exportCount: 1 }],
    mail: [
      { id: "am_s1", mailbox: "accounts@harbourbuild.com.au", folder: "inbox", fromAddress: "billing@supplyhub.com.au", fromName: "Supply Hub", to: ["accounts@harbourbuild.com.au"], subject: "Invoice 4471 overdue", snippet: "Please find attached", date: iso(now - 25 * day), hasAttachments: true, held: true },
      { id: "am_s2", mailbox: "hello@harbourbuild.com.au", folder: "sent", fromAddress: "hello@harbourbuild.com.au", fromName: "Harbour Build", to: ["tom@greenleaf.au"], subject: "Your invoice and next visit", snippet: "Thanks Tom", date: iso(now - 40 * day), hasAttachments: false, held: false },
    ],
    passwords: [{ id: "dav_s1", name: "Work iPhone", createdAt: iso(now - 12 * day), lastUsedAt: iso(now - day) }],
    seq: 1,
  };
}

/** Answers this part's routes, or undefined to let the next sample route try. */
export function m1MoreRoute(s: M1MoreState, method: string, path: string, body: unknown, now: number): unknown {
  const parts = path.split("/").filter(Boolean);
  const b = (body ?? {}) as Record<string, unknown>;
  if (parts[0] === "tools" && parts[1] === "campaigns") {
    const [, , kind, id, action] = parts;
    if (kind === "lists" && method === "GET" && !id) return { lists: s.lists };
    if (kind === "newsletters") {
      if (method === "GET" && !id) return { newsletters: s.newsletters };
      const n = s.newsletters.find((x) => x.id === id);
      if (!n) throw new ApiError(404, "not_found", "Newsletter not found.");
      if (method === "GET" && !action) return n;
      if (method === "POST" && action === "test") return { to: "you@harbourbuild.com.au" };
      if (method === "POST" && action === "pause") {
        if (n.status !== "sending") throw new ApiError(400, "bad_request", "Only a newsletter that is sending can be paused.");
        n.status = "paused"; return n;
      }
      if (method === "POST" && action === "resume") {
        if (n.status !== "paused") throw new ApiError(400, "bad_request", "This newsletter is not paused.");
        n.status = "sending"; return n;
      }
    }
    if (kind === "journeys") {
      if (method === "GET" && !id) return { journeys: s.journeys };
      const j = s.journeys.find((x) => x.id === id);
      if (!j) throw new ApiError(404, "not_found", "Journey not found.");
      if (method === "GET" && !action) return j;
      if (method === "POST" && (action === "pause" || action === "start")) { j.status = action === "pause" ? "paused" : "active"; return j; }
    }
    return undefined;
  }
  if (parts[0] === "mail-archive") {
    if (method === "GET" && parts[1] === "policy") return { policy: s.policy };
    if (method === "GET" && parts[1] === "holds" && !parts[2]) return { holds: s.holds };
    if (method === "GET" && parts[1] === "cases" && !parts[2]) return { cases: s.cases };
    if (method === "POST" && parts[1] === "search") {
      const q = String(((b.filters ?? {}) as Record<string, unknown>).q ?? "").toLowerCase();
      return { hits: s.mail.filter((m) => !q || `${m.subject} ${m.fromAddress} ${m.fromName ?? ""} ${m.snippet}`.toLowerCase().includes(q)), next: null };
    }
    return undefined;
  }
  if (parts[0] === "dav" && parts[1] === "passwords") {
    const list = () => ({ passwords: s.passwords, server: "https://preview.multies.si/dav/", username: "you@harbourbuild.com.au", max: 10 });
    if (method === "GET" && !parts[2]) return list();
    if (method === "POST" && !parts[2]) {
      s.seq += 1;
      const item: AppPasswordView = { id: `dav_s${s.seq}`, name: String(b.name ?? "My phone"), createdAt: new Date(now).toISOString(), lastUsedAt: null };
      s.passwords = [item, ...s.passwords];
      return { password: "abcd efgh ijkl mnop", item, server: list().server, username: list().username };
    }
    if (method === "DELETE" && parts[2]) {
      const before = s.passwords.length;
      s.passwords = s.passwords.filter((p) => p.id !== parts[2]);
      if (s.passwords.length === before) throw new ApiError(404, "not_found", "App password not found.");
      return { id: parts[2], revoked: true };
    }
  }
  return undefined;
}
