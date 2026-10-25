import { ApiError } from "@/api/errors";
import type { MailboxOverview } from "@/api/types";
import { CONNECT_PRESETS, localPartProblem, type ConnectInput, type ConnectPresetId, type ConnectionView } from "@/lib/mail-connect";

export interface SampleEmail {
  connections: ConnectionView[];
  free: { id: string; address: string; displayName: string }[];
}

export const SAMPLE_FREE_DOMAIN = "mail.multies.si";

/** One connected Gmail account, synced a few minutes ago, so Email addresses has something to show. */
export function sampleEmail(now: number): SampleEmail {
  return {
    connections: [{
      id: "con_s1", mailboxId: "mbx_s_con1", email: "ava.lin.studio@gmail.com", displayName: "Ava Lin", provider: "gmail", providerLabel: "Gmail",
      authKind: "password", status: "active", lastError: null, lastSyncAt: new Date(now - 4 * 60_000).toISOString(), initialDone: true,
      messagesSynced: 184, imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com", createdAt: new Date(now - 3 * 86400_000).toISOString(),
    }],
    free: [],
  };
}

/**
 * The sample answers for /connections and /free-address. A password of "wrong" fails the test the
 * way a provider does, so the error path can be seen without a server. Returns undefined for any
 * other path.
 */
export function emailRoute(s: SampleEmail, mailboxes: MailboxOverview[], method: string, parts: string[], body: unknown, now = Date.now()): unknown {
  if (parts[0] === "connections") {
    if (method === "GET" && parts.length === 1) return { enabled: true, oauth: { google: false, microsoft: false }, connections: s.connections };
    const b = (body ?? {}) as ConnectInput;
    const check = () => {
      if (b.password === "wrong") throw new ApiError(422, "auth_failed", "The password was refused. Use an app password from your provider, not your normal password.", { step: "imap" });
    };
    if (method === "POST" && parts[1] === "test") { check(); return { ok: true }; }
    if (method === "POST" && parts.length === 1) {
      check();
      if (s.connections.some((c) => c.email === b.email.toLowerCase())) throw new ApiError(409, "conflict", `${b.email} is already connected.`);
      const preset = (b.preset ?? "custom") as ConnectPresetId;
      const id = `con_s${s.connections.length + 2}`;
      const c: ConnectionView = {
        id, mailboxId: `mbx_s_${id}`, email: b.email.toLowerCase(), displayName: b.displayName ?? b.email.split("@")[0], provider: preset,
        providerLabel: CONNECT_PRESETS[preset]?.label ?? "Other server", authKind: "password", status: "syncing", lastError: null, lastSyncAt: null,
        initialDone: false, messagesSynced: 0, imapHost: b.imap?.host ?? CONNECT_PRESETS[preset]?.imap.host ?? "", smtpHost: b.smtp?.host ?? CONNECT_PRESETS[preset]?.smtp.host ?? "",
        createdAt: new Date(now).toISOString(),
      };
      s.connections.push(c);
      mailboxes.push({ id: c.mailboxId, address: c.email, displayName: c.displayName, usedBytes: 0, quotaMb: 0, kind: "person", folders: {} });
      return { connection: c };
    }
    const c = s.connections.find((x) => x.id === parts[1]);
    if (!c) throw new ApiError(404, "not_found", "That connected account is gone.");
    if (method === "POST" && parts[2] === "sync") {
      Object.assign(c, { status: "active", lastSyncAt: new Date(now).toISOString(), initialDone: true });
      return { result: { stored: 0, more: false, error: null, skipped: null }, connection: c };
    }
    if (method === "PUT") { check(); Object.assign(c, { status: "active", lastError: null }); return { connection: c }; }
    if (method === "DELETE") {
      s.connections.splice(s.connections.indexOf(c), 1);
      const i = mailboxes.findIndex((m) => m.id === c.mailboxId);
      if (i >= 0) mailboxes.splice(i, 1);
      return { ok: true };
    }
  }
  if (parts[0] === "free-address" && parts.length === 1) {
    if (method === "GET") return { enabled: true, domain: SAMPLE_FREE_DOMAIN, dailySends: 50, available: true, suggestion: "ava.harbour", addresses: s.free };
    if (method === "POST") {
      const local = String((body as { localPart?: string })?.localPart ?? "").trim().toLowerCase();
      const problem = localPartProblem(local);
      if (problem) throw new ApiError(400, "bad_request", problem);
      if (s.free.length) throw new ApiError(409, "free_mail_one_each", "You already have a free address. Each person gets one.");
      if (local === "ava") throw new ApiError(409, "conflict", `ava@${SAMPLE_FREE_DOMAIN} is taken. Try another, for example with your team's name.`);
      const m = { id: "mbx_s_free", address: `${local}@${SAMPLE_FREE_DOMAIN}`, displayName: "Ava Lin" };
      s.free.push(m);
      mailboxes.push({ id: m.id, address: m.address, displayName: m.displayName, usedBytes: 0, quotaMb: 1024, kind: "person", folders: {} });
      return { mailbox: m };
    }
  }
  return undefined;
}
