import type { Transport } from "./transport";
import type { SnoozePreset } from "@/lib/snooze";
import type { ConnectInput, ConnectionView, ConnectionsInfo, FreeAddressInfo } from "@/lib/mail-connect";
import type {
  AgentRun, Agent, Approval, Assignee, ChecklistItem, ChecklistView, ChangePage, ListFolder, MailboxOverview, Me, MessagePage, Project, SendInput, SendResult,
  CustomField, ChatChannel, ChatMessage, ChatPerson, ChatSend, ChatUnread, NotificationPage, NotificationSettings, NotificationView, Meeting, MeetingCreate, Person, PortfolioProject, Task, TaskComment, TaskCreate, TaskPatch, TaskQuery, TaskView, ThreadView, TimeEntry, TimeLog,
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
    /** Trades the identity provider's ID token for a Multies session cookie. */
    exchangeIdToken: (idToken: string, nonce: string) => t.request<{ ok: true }>("POST", "/auth/mobile/exchange", { idToken, nonce }),

    /** Deletes the signed in person's account. The session ends with it. */
    deleteAccount: (password?: string) =>
      t.request<{ ok: true; deletedWorkspaces: number }>("DELETE", "/account", password ? { confirm: "DELETE", password } : { confirm: "DELETE" }),

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
    // R31: snooze a conversation (server R20.3 mail schedules). It leaves the inbox and comes back at the time.
    snoozeMessage: (messageId: string, preset: SnoozePreset) => t.request<unknown>("POST", "/mail-schedules/snooze", { messageId, preset }),
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
    // R27: checklists inside a task (server R26, MB-85).
    checklist: (taskId: string) => t.request<ChecklistView>("GET", `/tasks/${encodeURIComponent(taskId)}/checklist`),
    addChecklistItem: (taskId: string, title: string) =>
      t.request<{ items: ChecklistItem[] }>("POST", `/tasks/${encodeURIComponent(taskId)}/checklist`, { title }),
    updateChecklistItem: (id: string, patch: { title?: string; done?: boolean }) =>
      t.request<{ item: ChecklistItem }>("PATCH", `/checklist-items/${encodeURIComponent(id)}`, patch),
    deleteChecklistItem: (id: string) => t.request<unknown>("DELETE", `/checklist-items/${encodeURIComponent(id)}`),
    reorderChecklist: (taskId: string, ids: string[]) =>
      t.request<unknown>("POST", `/tasks/${encodeURIComponent(taskId)}/checklist/reorder`, { ids }),

    // R29: agent runs, read only (server R27 session routes; the workspace list is /agent-runs).
    runs: (p: { agentUserId?: string; status?: string; limit?: number } = {}) =>
      t.request<{ runs: AgentRun[] }>("GET", `/agent-runs${q({ agentUserId: p.agentUserId, status: p.status, limit: p.limit ?? 50 })}`),
    run: (id: string) => t.request<{ run: AgentRun }>("GET", `/agent-runs/${encodeURIComponent(id)}`),
    // R31: cancel a queued or running run (server R30, the same rules as POST /api/v1/runs/{id}/cancel).
    cancelRun: (id: string, reason?: string) => t.request<{ run: AgentRun }>("POST", `/agent-runs/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {}),
    taskRuns: (taskId: string) => t.request<{ taskId: string; ref: string; runs: AgentRun[] }>("GET", `/tasks/${encodeURIComponent(taskId)}/runs`),
    projects: () => t.request<{ projects: Project[] }>("GET", "/projects"),
    changes: (since: number) => t.request<ChangePage>("GET", `/changes${q({ since })}`),
    // Notifications inbox. No ids and no category marks everything read.
    notifications: (p: { unread?: boolean; category?: string; limit?: number; before?: string; view?: NotificationView } = {}) =>
      t.request<NotificationPage>("GET", `/notifications${q({ view: p.view, unread: p.unread ? 1 : undefined, category: p.category, limit: p.limit, before: p.before })}`),
    // R31 triage: done, back to Inbox, snooze (a preset or an exact time) and done in bulk.
    notificationDone: (id: string) => t.request<{ ok: true }>("POST", `/notifications/${encodeURIComponent(id)}/done`, {}),
    notificationUndone: (id: string) => t.request<{ ok: true }>("POST", `/notifications/${encodeURIComponent(id)}/undone`, {}),
    notificationSnooze: (id: string, when: { preset: SnoozePreset } | { until: string }) =>
      t.request<{ ok: true }>("POST", `/notifications/${encodeURIComponent(id)}/snooze`, when),
    notificationsDone: (ids: string[]) => t.request<{ ok: true; updated?: number }>("POST", "/notifications/done", { ids }),
    readNotifications: (p: { ids?: string[]; category?: string } = {}) =>
      t.request<{ ok: true; updated: number }>("POST", "/notifications/read", { ...(p.ids ? { ids: p.ids } : {}), ...(p.category ? { category: p.category } : {}) }),
    unreadNotification: (id: string) => t.request<{ ok: true }>("POST", `/notifications/${encodeURIComponent(id)}/unread`, {}),
    notificationSettings: () => t.request<{ settings: NotificationSettings }>("GET", "/notifications/settings"),
    saveNotificationSettings: (settings: Partial<Record<string, Partial<{ inApp: boolean; push: boolean }>>>) =>
      t.request<{ settings: NotificationSettings }>("PUT", "/notifications/settings", { settings }),

    // Team chat. Bodies use the plain markup in lib/chat.ts; the server resolves mentions and links.
    chatChannels: () => t.request<{ channels: ChatChannel[] }>("GET", "/chat/channels"),
    chatChannel: (id: string) => t.request<{ channel: ChatChannel }>("GET", `/chat/channels/${encodeURIComponent(id)}`),
    chatMessages: (id: string, p: { limit?: number; before?: string; since?: string } = {}) =>
      t.request<{ messages: ChatMessage[]; hasMore: boolean }>("GET", `/chat/channels/${encodeURIComponent(id)}/messages${q({ limit: p.limit, before: p.before, since: p.since })}`),
    chatMessage: (id: string) => t.request<{ message: ChatMessage; channel: ChatChannel }>("GET", `/chat/messages/${encodeURIComponent(id)}`),
    chatThread: (id: string) => t.request<{ message: ChatMessage; replies: ChatMessage[] }>("GET", `/chat/messages/${encodeURIComponent(id)}/thread`),
    sendChat: (channelId: string, input: ChatSend, opts: { onUploadProgress?: (fraction: number) => void } = {}) =>
      t.request<{ message: ChatMessage }>("POST", `/chat/channels/${encodeURIComponent(channelId)}/messages`, input, opts.onUploadProgress ? { onUploadProgress: opts.onUploadProgress } : undefined),
    readChannel: (id: string, messageId?: string) => t.request<{ ok: true }>("POST", `/chat/channels/${encodeURIComponent(id)}/read`, messageId ? { messageId } : {}),
    joinChannel: (id: string) => t.request<{ channel: ChatChannel }>("POST", `/chat/channels/${encodeURIComponent(id)}/join`, {}),
    chatUnread: () => t.request<ChatUnread>("GET", "/chat/unread"),
    chatPeople: () => t.request<{ people: ChatPerson[] }>("GET", "/chat/people"),
    startDm: (userIds: string[]) => t.request<{ channel: ChatChannel }>("POST", "/chat/dms", { userIds }),
    chatMessageToTask: (id: string, input: { title?: string; projectId?: string } = {}) => t.request<{ task: Task }>("POST", `/chat/messages/${encodeURIComponent(id)}/task`, input),

    // Time tracking. One timer runs per person; starting a new one stops the old one first.
    runningTimer: () => t.request<{ entry: TimeEntry | null }>("GET", "/time/running"),
    startTimer: (taskId: string, note?: string) => t.request<{ entry: TimeEntry }>("POST", "/time/start", note ? { taskId, note } : { taskId }),
    stopTimer: () => t.request<{ entry: TimeEntry | null }>("POST", "/time/stop", {}),
    logTime: (input: TimeLog) => t.request<{ entry: TimeEntry }>("POST", "/time", input),
    timeEntries: (taskId: string) => t.request<{ entries: TimeEntry[] }>("GET", `/time${q({ taskId })}`),

    // Meetings. Video runs in the browser: the app opens joinUrl, guests use guestUrl.
    meetings: (upcoming = true) => t.request<{ meetings: Meeting[]; videoEnabled: boolean }>("GET", `/meetings${q({ upcoming: upcoming ? 1 : undefined })}`),
    fields: (projectId: string) => t.request<{ fields: CustomField[] }>("GET", `/fields${q({ projectId })}`),
    portfolio: () => t.request<{ projects: PortfolioProject[] }>("GET", "/portfolio"),
    // People and AI agent members with titles and bios (read only on the phone).
    people: () => t.request<{ people: Person[] }>("GET", "/team/people"),
    createMeeting: (input: MeetingCreate) => t.request<{ meeting: Meeting; invites?: unknown }>("POST", "/meetings", input),

    // Push devices. The server only sends when push is switched on there; `enabled` says which.
    registerPushDevice: (token: string, platform: "ios" | "android") => t.request<{ ok: true; enabled: boolean }>("POST", "/push/devices", { token, platform }),
    unregisterPushDevice: (token: string) => t.request<{ ok: true }>("DELETE", `/push/devices/${encodeURIComponent(token)}`),
    pushDevices: () => t.request<{ enabled: boolean; devices: { token: string; platform: string; lastSeenAt: string }[] }>("GET", "/push/devices"),

    // Email addresses from the phone: connect an existing mailbox (IMAP and SMTP) or take a free address.
    connections: () => t.request<ConnectionsInfo>("GET", "/connections"),
    /** Signs in to the provider without saving anything. A failure answers 422 with plain words and the step. */
    testConnection: (input: ConnectInput) => t.request<unknown>("POST", "/connections/test", input),
    /** Tests again, saves (password encrypted on the server) and starts the first sync. */
    connect: (input: ConnectInput) => t.request<{ connection: ConnectionView }>("POST", "/connections", input),
    syncConnection: (id: string) => t.request<{ result: { stored: number; more: boolean; error: string | null; skipped: string | null }; connection?: ConnectionView }>("POST", `/connections/${encodeURIComponent(id)}/sync`, {}),
    reconnect: (id: string, password: string) => t.request<{ connection: ConnectionView }>("PUT", `/connections/${encodeURIComponent(id)}`, { password }),
    /** Stops syncing and deletes the stored password. */
    removeConnection: (id: string) => t.request<unknown>("DELETE", `/connections/${encodeURIComponent(id)}`),
    freeAddress: () => t.request<FreeAddressInfo>("GET", "/free-address"),
    /** Takes a free address. The server checks the name is allowed and free, and its limits. */
    claimFreeAddress: (localPart: string) => t.request<{ mailbox: { id: string; address: string } }>("POST", "/free-address", { localPart }),
    /** R26: is this name free? Reads only (same rules as a claim), so the field can say so while typing. */
    checkFreeAddress: (localPart: string) => t.request<{ address: string | null; available: boolean; problem: string | null }>("GET", `/free-address/check?localPart=${encodeURIComponent(localPart)}`),
  };
}

export type Api = ReturnType<typeof endpoints>;
