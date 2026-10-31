import type { RequestOptions, Transport } from "./transport";
import type { Counts } from "@/lib/counts";
import type { BlockedPerson, ReportInput } from "@/lib/moderation";
import type { SnoozePreset } from "@/lib/snooze";
import type { ConnectInput, ConnectionView, ConnectionsInfo, FreeAddressInfo } from "@/lib/mail-connect";
import type {
  AgentRun, Agent, Approval, Assignee, ChecklistItem, ChecklistView, ChangePage, ListFolder, MailboxOverview, Me, MessagePage, MessageSummary, Project, SendInput, SendResult,
  CustomField, ChatChannel, ChatMessage, ChatPerson, ChatSend, ChatUnread, NotificationPage, NotificationSettings, NotificationView, Meeting, MeetingCreate, Person, PortfolioProject, Task, TaskComment, TaskCreate, TaskPatch, TaskQuery, TaskView, ThreadView, TimeEntry, TimeLog, WorkspaceSummary,
} from "./types";

import type { ToolJob, ToolsInfo } from "@/lib/tools";
import type { InboxTabs, MailRule, MailRuleRun, RuleInput, RuleTestResult, TabStyle } from "@/lib/mail-rules";
import type { InboxItemView, InboxListResponse, InboxNoteView, InboxPatch, InboxThreadResponse, SavedReplyView } from "@/lib/social-inbox";
import type { ConnectedAccountView, DeleteResult, DirectStatusResponse, NewSocialPost, SocialAccountHealth, SocialPostView, TargetOption } from "@/lib/social";

/** One pending snooze (GET /api/mail-schedules?view=snoozed) or one that came back (view=returned). */
export interface SnoozedItem { id: string; kind: string; status: string; mailboxId: string; threadId: string | null; messageId: string | null; dueAt: string; message: MessageSummary | null }

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
    /** Multiws: every workspace this person belongs to, and moving this phone's session to another. */
    workspaces: () => t.request<{ workspaces: WorkspaceSummary[] }>("GET", "/account/workspaces"),
    switchWorkspace: (id: string) => t.request<{ ok: true; workspace?: { id: string; name: string } }>("POST", `/account/workspaces/${encodeURIComponent(id)}/switch`, {}),
    overview: () => t.request<{ mailboxes: MailboxOverview[] }>("GET", "/mail/overview"),
    messages: (p: { folder?: ListFolder; q?: string; cursor?: string; mailboxId?: string; limit?: number; split?: string; label?: string }) =>
      t.request<MessagePage>("GET", `/mail/messages${q({ folder: p.folder, q: p.q, cursor: p.cursor, mailboxId: p.mailboxId, limit: p.limit ?? 40, split: p.split, label: p.label })}`),
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
    // Tools (document tools, the same catalogue as the web). 404 when the server or the workspace has them off.
    tools: () => t.request<ToolsInfo>("GET", "/tools"),
    toolJob: (token: string) => t.request<ToolJob>("GET", `/tools/jobs/${encodeURIComponent(token)}`),
    toolFromAttachments: (op: string, attachmentIds: string[], options: Record<string, string>) =>
      t.request<ToolJob>("POST", "/tools/jobs/from-attachments", { op, attachmentIds, options }),
    // Tools P2: Cancel stops the job on the engine and frees its place (never counted); warm wakes a sleeping engine.
    cancelToolJob: (token: string) => t.request<ToolJob>("DELETE", `/tools/jobs/${encodeURIComponent(token)}`),
    toolsWarm: () => t.request<{ ok: boolean; ms: number }>("GET", "/tools/warm"),
    chatMessage: (id: string) => t.request<{ message: ChatMessage; channel: ChatChannel }>("GET", `/chat/messages/${encodeURIComponent(id)}`),
    chatThread: (id: string) => t.request<{ message: ChatMessage; replies: ChatMessage[] }>("GET", `/chat/messages/${encodeURIComponent(id)}/thread`),
    sendChat: (channelId: string, input: ChatSend, opts: { onUploadProgress?: (fraction: number) => void } = {}) =>
      t.request<{ message: ChatMessage }>("POST", `/chat/channels/${encodeURIComponent(channelId)}/messages`, input, opts.onUploadProgress ? { onUploadProgress: opts.onUploadProgress } : undefined),
    readChannel: (id: string, messageId?: string) => t.request<{ ok: true }>("POST", `/chat/channels/${encodeURIComponent(id)}/read`, messageId ? { messageId } : {}),
    joinChannel: (id: string) => t.request<{ channel: ChatChannel }>("POST", `/chat/channels/${encodeURIComponent(id)}/join`, {}),
    chatUnread: () => t.request<ChatUnread>("GET", "/chat/unread"),
    /** R34: every badge count in one call, with an ETag (304 when nothing changed). */
    counts: (opts?: RequestOptions) => t.request<Counts>("GET", "/counts", undefined, opts),
    chatPeople: () => t.request<{ people: ChatPerson[] }>("GET", "/chat/people"),
    startDm: (userIds: string[]) => t.request<{ channel: ChatChannel }>("POST", "/chat/dms", { userIds }),
    chatMessageToTask: (id: string, input: { title?: string; projectId?: string } = {}) => t.request<{ task: Task }>("POST", `/chat/messages/${encodeURIComponent(id)}/task`, input),
    // R35: report and block (App Store guideline 1.2). See lib/moderation.ts for the contract.
    report: (input: ReportInput) => t.request<{ id: string; status: "open" }>("POST", "/reports", input),
    blocks: () => t.request<{ blocks: BlockedPerson[] }>("GET", "/blocks"),
    block: (userId: string) => t.request<unknown>("POST", "/blocks", { userId }),
    unblock: (userId: string) => t.request<unknown>("DELETE", `/blocks/${encodeURIComponent(userId)}`),

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

    // 1.10.5: social posts and the accounts they go to (the web's session routes /api/social, /api/apps, /api/direct).
    socialPosts: () => t.request<{ posts: SocialPostView[] }>("GET", "/social/posts"),
    createSocialPost: (input: NewSocialPost, idempotencyKey?: string) => t.request<{ post: SocialPostView }>("POST", "/social/posts", input, { idempotencyKey }),
    retrySocialPost: (id: string) => t.request<{ post: SocialPostView }>("POST", `/social/posts/${encodeURIComponent(id)}/retry`, {}),
    cancelSocialPost: (id: string) => t.request<{ post: SocialPostView }>("POST", `/social/posts/${encodeURIComponent(id)}/cancel`, {}),
    /** Account checks before writing. Servers from before this check answer 404, which the app treats as "no checks". */
    socialHealth: (fresh = false) => t.request<{ accounts: SocialAccountHealth[] }>("GET", fresh ? "/social/health?fresh=1" : "/social/health"),
    // 1.10.6: one post, the posts on screen checked against their network (Facebook), and delete (also on the networks).
    socialPost: (id: string) => t.request<{ post: SocialPostView }>("GET", `/social/posts/${encodeURIComponent(id)}`),
    syncSocialPosts: (ids: string[]) => t.request<{ posts: SocialPostView[] }>("POST", "/social/posts/sync", { ids }),
    deleteSocialPost: (id: string) => t.request<DeleteResult>("DELETE", `/social/posts/${encodeURIComponent(id)}`),
    // 1.10.8: the Social inbox (server R118, session routes under /api/social; 404 when it is off for the workspace).
    socialInbox: (query: string) => t.request<InboxListResponse>("GET", `/social/inbox${query}`),
    syncSocialInbox: () => t.request<unknown>("POST", "/social/inbox/sync", {}),
    socialInboxThread: (id: string) => t.request<InboxThreadResponse>("GET", `/social/inbox/${encodeURIComponent(id)}`),
    patchSocialInbox: (id: string, patch: InboxPatch) => t.request<{ item: InboxItemView }>("PATCH", `/social/inbox/${encodeURIComponent(id)}`, patch),
    noteSocialInbox: (id: string, text: string) => t.request<{ note: InboxNoteView }>("POST", `/social/inbox/${encodeURIComponent(id)}/notes`, { text }),
    replySocialInbox: (id: string, text: string) => t.request<{ note: InboxNoteView; item: InboxItemView }>("POST", `/social/inbox/${encodeURIComponent(id)}/reply`, { text }),
    taskFromSocialInbox: (id: string) => t.request<{ taskId: string; item: InboxItemView }>("POST", `/social/inbox/${encodeURIComponent(id)}/task`, {}),
    socialSavedReplies: () => t.request<{ replies: SavedReplyView[] }>("GET", "/social/saved-replies"),
    appsStatus: () => t.request<{ available: boolean; canManage: boolean }>("GET", "/apps/status"),
    appAccounts: () => t.request<{ accounts: ConnectedAccountView[] }>("GET", "/apps/accounts"),
    /** Starts a sign in with the network. The phone opens redirectUrl in the browser, then confirms. */
    connectApp: (app: string) => t.request<{ redirectUrl: string; accountId: string }>("POST", "/apps/connect", { app }),
    confirmApp: (id: string) => t.request<{ account: ConnectedAccountView }>("POST", `/apps/accounts/${encodeURIComponent(id)}/confirm`, {}),
    reconnectApp: (id: string) => t.request<{ redirectUrl: string }>("POST", `/apps/accounts/${encodeURIComponent(id)}/reconnect`, {}),
    appTargets: (id: string) => t.request<{ targets: TargetOption[] }>("GET", `/apps/accounts/${encodeURIComponent(id)}/targets`),
    directStatus: () => t.request<DirectStatusResponse>("GET", "/direct/status"),

    // 1.10.7: Inbox tabs, labels, snoozed mail and mail rules (the web's R85 session routes; nothing new on the server).
    inboxTabs: (mailboxId?: string) => t.request<InboxTabs & { splits?: unknown[] }>("GET", `/mail/splits${q({ mailboxId })}`),
    tabSettings: () => t.request<{ style: TabStyle; chosen: boolean; defaultTab: string; senders: { address: string; tab: string }[] }>("GET", "/mail/splits/settings"),
    setTabStyle: (style: TabStyle) => t.request<{ style: TabStyle; defaultTab: string }>("PUT", "/mail/splits/style", { style }),
    teachTab: (messageId: string, tab: string, sender: boolean) =>
      t.request<{ tab: string; threadId: string; sender: string | null; previous: { thread: string | null; sender?: string | null } }>("POST", "/mail/splits/teach", { messageId, tab, sender }),
    restorePins: (input: { threadId?: string; thread?: string | null; sender?: string; senderTab?: string | null }) => t.request<unknown>("POST", "/mail/splits/pins/restore", input),
    labels: () => t.request<{ labels: { label: string; threads: number }[] }>("GET", "/mail/labels"),
    addLabel: (threadId: string, label: string) => t.request<{ labels: string[] }>("POST", "/mail/labels", { threadId, label }),
    removeLabel: (threadId: string, label: string) => t.request<{ labels: string[] }>("DELETE", `/mail/labels${q({ threadId, label })}`),
    snoozed: (view: "snoozed" | "returned", mailboxId?: string) => t.request<{ items: SnoozedItem[] }>("GET", `/mail-schedules${q({ view, mailboxId })}`),
    /** Ends a snooze now: the mail is back in Inbox. */
    unsnooze: (scheduleId: string) => t.request<{ ok: true }>("DELETE", `/mail-schedules/${encodeURIComponent(scheduleId)}`),
    mailRules: () => t.request<{ rules: MailRule[] }>("GET", "/mail/rules"),
    mailRule: (id: string) => t.request<{ rule: MailRule }>("GET", `/mail/rules/${encodeURIComponent(id)}`),
    mailRuleRuns: (id: string) => t.request<{ runs: MailRuleRun[] }>("GET", `/mail/rules/${encodeURIComponent(id)}/runs`),
    createMailRule: (input: RuleInput) => t.request<{ rule: MailRule }>("POST", "/mail/rules", input),
    updateMailRule: (id: string, patch: Partial<RuleInput>) => t.request<{ rule: MailRule }>("PATCH", `/mail/rules/${encodeURIComponent(id)}`, patch),
    deleteMailRule: (id: string) => t.request<{ deleted: true }>("DELETE", `/mail/rules/${encodeURIComponent(id)}`),
    testMailRule: (input: { mailboxId: string; match: "all" | "any"; conditions: RuleInput["conditions"] }) => t.request<RuleTestResult>("POST", "/mail/rules/test", input),
    runMailRuleRecent: (id: string) => t.request<{ ran: number; matched: number }>("POST", `/mail/rules/${encodeURIComponent(id)}/run-recent`, {}),
  };
}

export type Api = ReturnType<typeof endpoints>;
