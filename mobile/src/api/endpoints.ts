import type { Transport } from "./transport";
import type {
  Agent, Approval, AppNotification, Assignee, ChangePage, ListFolder, MailboxOverview, Me, MessagePage, Project, SendInput, SendResult,
  Meeting, MeetingCreate, Task, TaskComment, TaskCreate, TaskPatch, TaskQuery, TaskView, ThreadView, TimeEntry, TimeLog,
} from "./types";

export interface SignInResult { twoFactorRedirect?: boolean; user?: { email: string } }

/** The API calls the app makes. Paths are the web app's own session routes under /api. */
export function endpoints(t: Transport) {
  const q = (params: Record<string, string | number | boolean | undefined>) => {
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

    /** A private sample workspace on the server, signed in. Only where the server has demo mode on. */
    startDemo: () => t.request<{ ok: true }>("POST", "/account/demo", {}),
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

    // Work management: the same session routes the web app's boards use.
    tasks: (p: TaskQuery = {}) => t.request<{ tasks: Task[] }>("GET", `/tasks${q({ ...p, includeSubtasks: p.includeSubtasks ? "true" : undefined })}`),
    task: (id: string) => t.request<TaskView>("GET", `/tasks/${encodeURIComponent(id)}`),
    createTask: (input: TaskCreate) => t.request<{ task: Task }>("POST", "/tasks", input),
    taskFromEmail: (input: { messageId?: string; threadId?: string; title?: string; notes?: string; due?: string; priority?: Task["priority"] }) =>
      t.request<{ task: Task }>("POST", "/tasks/from-email", input),
    updateTask: (id: string, patch: TaskPatch) => t.request<{ task: Task }>("PATCH", `/tasks/${encodeURIComponent(id)}`, patch),
    deleteTask: (id: string) => t.request<{ ok: true }>("DELETE", `/tasks/${encodeURIComponent(id)}`),
    addComment: (id: string, body: string) => t.request<{ comment: TaskComment }>("POST", `/tasks/${encodeURIComponent(id)}/comments`, { body }),
    assignees: () => t.request<{ assignees: Assignee[] }>("GET", "/tasks/assignees"),
    projects: () => t.request<{ projects: Project[] }>("GET", "/projects"),
    changes: (since: number) => t.request<ChangePage>("GET", `/changes${q({ since })}`),
    notifications: (unread = false) => t.request<{ notifications: AppNotification[] }>("GET", `/notifications${q({ unread: unread ? 1 : undefined })}`),
    readNotifications: (ids?: string[]) => t.request<{ marked: number }>("POST", "/notifications/read", ids ? { ids } : {}),

    // Time tracking. One timer runs per person; starting a new one stops the old one first.
    runningTimer: () => t.request<{ entry: TimeEntry | null }>("GET", "/time/running"),
    startTimer: (taskId: string, note?: string) => t.request<{ entry: TimeEntry }>("POST", "/time/start", note ? { taskId, note } : { taskId }),
    stopTimer: () => t.request<{ entry: TimeEntry | null }>("POST", "/time/stop", {}),
    logTime: (input: TimeLog) => t.request<{ entry: TimeEntry }>("POST", "/time", input),
    timeEntries: (taskId: string) => t.request<{ entries: TimeEntry[] }>("GET", `/time${q({ taskId })}`),

    // Meetings. Video runs in the browser: the app opens joinUrl, guests use guestUrl.
    meetings: (upcoming = true) => t.request<{ meetings: Meeting[]; videoEnabled: boolean }>("GET", `/meetings${q({ upcoming: upcoming ? 1 : undefined })}`),
    createMeeting: (input: MeetingCreate) => t.request<{ meeting: Meeting; invites?: unknown }>("POST", "/meetings", input),

    // Push devices. The server only sends when push is switched on there; `enabled` says which.
    registerPushDevice: (token: string, platform: "ios" | "android") => t.request<{ ok: true; enabled: boolean }>("POST", "/push/devices", { token, platform }),
    unregisterPushDevice: (token: string) => t.request<{ ok: true }>("DELETE", `/push/devices/${encodeURIComponent(token)}`),
    pushDevices: () => t.request<{ enabled: boolean; devices: { token: string; platform: string; lastSeenAt: string }[] }>("GET", "/push/devices"),
  };
}

export type Api = ReturnType<typeof endpoints>;
