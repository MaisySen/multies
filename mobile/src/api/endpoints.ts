import type { Transport } from "./transport";
import type { Agent, Approval, ListFolder, MailboxOverview, Me, MessagePage, SendInput, SendResult, ThreadView } from "./types";

export interface SignInResult { twoFactorRedirect?: boolean; user?: { email: string } }

/** The API calls the app makes. Paths are the web app's own session routes under /api. */
export function endpoints(t: Transport) {
  const q = (params: Record<string, string | number | undefined>) => {
    const s = Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    return s ? `?${s}` : "";
  };
  return {
    // Better Auth, under /api/auth
    signIn: (email: string, password: string) => t.request<SignInResult>("POST", "/auth/sign-in/email", { email, password, rememberMe: true }),
    verifyTotp: (code: string, trustDevice: boolean) => t.request<unknown>("POST", "/auth/two-factor/verify-totp", { code, trustDevice }),
    verifyBackupCode: (code: string) => t.request<unknown>("POST", "/auth/two-factor/verify-backup-code", { code }),
    signOut: () => t.request<unknown>("POST", "/auth/sign-out", {}),
    deleteAccount: (password: string) => t.request<{ success?: boolean }>("POST", "/auth/delete-user", { password }),

    me: () => t.request<Me>("GET", "/account/me"),
    overview: () => t.request<{ mailboxes: MailboxOverview[] }>("GET", "/mail/overview"),
    messages: (p: { folder?: ListFolder; q?: string; cursor?: string; mailboxId?: string; limit?: number }) =>
      t.request<MessagePage>("GET", `/mail/messages${q({ folder: p.folder, q: p.q, cursor: p.cursor, mailboxId: p.mailboxId, limit: p.limit ?? 40 })}`),
    message: (id: string) => t.request<ThreadView>("GET", `/mail/messages/${encodeURIComponent(id)}`),
    updateMessage: (id: string, patch: { isRead?: boolean; isStarred?: boolean; folder?: "inbox" | "archive" | "spam" | "trash" }) =>
      t.request<{ ok: true }>("PATCH", `/mail/messages/${encodeURIComponent(id)}`, patch),
    trash: (id: string) => t.request<{ ok: true }>("DELETE", `/mail/messages/${encodeURIComponent(id)}`),
    send: (input: SendInput, idempotencyKey: string) => t.request<SendResult>("POST", "/mail/send", input, { idempotencyKey }),

    approvals: (status?: Approval["status"]) => t.request<{ approvals: Approval[] }>("GET", `/approvals${q({ status })}`),
    approve: (id: string, edits: { subject?: string; text?: string } = {}) =>
      t.request<{ approval: Approval }>("POST", `/approvals/${encodeURIComponent(id)}/approve`, edits),
    reject: (id: string, note?: string) => t.request<{ approval: Approval }>("POST", `/approvals/${encodeURIComponent(id)}/reject`, note ? { note } : {}),
    agents: () => t.request<{ agents: Agent[] }>("GET", "/agents"),

    /** Not on the API yet: see docs/push.md. Only called when FEATURES.pushServer is on. */
    registerPushDevice: (token: string, platform: string) => t.request<{ ok: true }>("POST", "/push/devices", { token, platform }),
  };
}

export type Api = ReturnType<typeof endpoints>;
