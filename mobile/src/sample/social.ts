import { ApiError } from "@/api/errors";
import type { InboxItemView, InboxNoteView, InboxSourceView, SavedReplyView } from "@/lib/social-inbox";
import { replyWindow } from "@/lib/social-inbox";
import type { ConnectedAccountView, DirectStatusResponse, NewSocialPost, SocialPostView } from "@/lib/social";

/**
 * 1.10.5: the sample workspace's social posts and accounts, on the device. One post went out to both
 * networks, one was turned down by LinkedIn with the network's own words, and one waits for tomorrow.
 */
export function sampleSocial(now: number) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const accounts: ConnectedAccountView[] = [
    { id: "ca_fb", app: "facebook", appName: "Facebook Pages", logo: null, status: "active", label: "Harbour Bakery", createdAt: iso(now - 9 * 86400_000) },
    { id: "ca_li", app: "linkedin", appName: "LinkedIn", logo: null, status: "active", label: "Sam Lee", createdAt: iso(now - 9 * 86400_000) },
    { id: "ca_ig", app: "instagram", appName: "Instagram", logo: null, status: "expired", label: "@harbourbakery", createdAt: iso(now - 30 * 86400_000) },
  ];
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const posts: SocialPostView[] = [
    {
      id: "sp_3", text: "Saturday market stall is back this week, from 7 am at the wharf.", imageUrl: null, status: "scheduled", runAt: tomorrow.toISOString(), createdAt: iso(now - 3600_000), createdBy: "Sam Lee",
      targets: [{ accountId: "ca_fb", app: "facebook", label: "Harbour Bakery", target: "pg_1", targetName: "Harbour Bakery", status: "pending", url: null, error: null, sentAt: null, networkState: null, checkedAt: null, canCheck: true, canDelete: true }],
    },
    {
      id: "sp_2", text: "New sourdough loaf this week. Order ahead for Saturday.", imageUrl: null, status: "partial", runAt: iso(now - 2 * 3600_000), createdAt: iso(now - 2 * 3600_000), createdBy: "Sam Lee",
      targets: [
        { accountId: "ca_fb", app: "facebook", label: "Harbour Bakery", target: "pg_1", targetName: "Harbour Bakery", status: "sent", url: "https://www.facebook.com/", error: null, sentAt: iso(now - 2 * 3600_000), networkState: "live", checkedAt: iso(now - 60_000), canCheck: true, canDelete: true },
        { accountId: "ca_li", app: "linkedin", label: "Sam Lee", target: null, targetName: null, status: "failed", url: null, error: "no_permission", sentAt: null, networkState: null, checkedAt: null, canCheck: false, canDelete: true },
      ],
    },
    {
      id: "sp_1", text: "Thanks to everyone who came to the open day. We baked 400 loaves and every one went home with someone.", imageUrl: null, status: "done", runAt: iso(now - 3 * 86400_000), createdAt: iso(now - 3 * 86400_000), createdBy: "Sam Lee",
      targets: [
        { accountId: "ca_fb", app: "facebook", label: "Harbour Bakery", target: "pg_1", targetName: "Harbour Bakery", status: "sent", url: null, error: null, sentAt: iso(now - 3 * 86400_000), networkState: "removed", checkedAt: iso(now - 60_000), canCheck: true, canDelete: true },
        { accountId: "ca_li", app: "linkedin", label: "Sam Lee", target: null, targetName: null, status: "sent", url: "https://www.linkedin.com/", error: null, sentAt: iso(now - 3 * 86400_000), networkState: null, checkedAt: null, canCheck: false, canDelete: true },
      ],
    },
  ];
  const direct: DirectStatusResponse = {
    canManage: true,
    accounts: [
      { provider: "tiktok", available: true, testMode: true, connected: false, status: null, username: null, displayName: null, avatarUrl: null, profileUrl: null, connectedAt: null },
      { provider: "threads", available: true, testMode: false, connected: true, status: "active", username: "harbourbakery", displayName: "Harbour Bakery", avatarUrl: null, profileUrl: null, connectedAt: iso(now - 86400_000) },
    ],
  };
  // 1.10.8: the sample Social inbox. Made up people on made up pages; nothing here reaches a real network.
  const item = (o: Partial<InboxItemView> & Pick<InboxItemView, "id" | "app" | "kind" | "text">): InboxItemView => ({
    accountId: o.app === "instagram" ? "ca_ig" : "ca_fb", accountLabel: o.app === "instagram" ? "@harbourbakery" : "Harbour Bakery", status: "open",
    authorName: null, authorHandle: null, postUrl: null, postText: null, receivedAt: iso(now - 3600_000), lastInboundAt: null, repliedAt: null,
    assigneeId: null, assigneeName: null, contactId: null, contactName: null, taskId: null, ...o,
  });
  const inbox: InboxItemView[] = [
    item({ id: "si_1", app: "facebook", kind: "message", text: "Hi, do you still have the rye loaf for Saturday? I'd like two.", authorName: "Priya Nair", receivedAt: iso(now - 25 * 60_000), lastInboundAt: iso(now - 25 * 60_000) }),
    item({ id: "si_2", app: "instagram", kind: "comment", text: "These look amazing. Are they vegan?", authorHandle: "maya.eats", postText: "New sourdough loaf this week. Order ahead for Saturday.", receivedAt: iso(now - 2 * 3600_000), assigneeId: "u_ana", assigneeName: "Ana Ruiz" }),
    item({ id: "si_3", app: "instagram", kind: "message", text: "Can I pick up my order a bit later, around 6?", authorName: "Tom Becker", receivedAt: iso(now - (23 * 60 + 20) * 60_000), lastInboundAt: iso(now - (23 * 60 + 20) * 60_000), assigneeId: "u_sam", assigneeName: "Sam Lee" }),
    item({ id: "si_4", app: "facebook", kind: "comment", text: "Best croissants on the coast!", authorName: "Lena Ford", postText: "Thanks to everyone who came to the open day.", receivedAt: iso(now - 26 * 3600_000) }),
    item({ id: "si_5", app: "facebook", kind: "message", text: "Do you cater for weddings?", authorName: "Chris Wong", receivedAt: iso(now - 30 * 3600_000), lastInboundAt: iso(now - 30 * 3600_000) }),
    item({ id: "si_6", app: "facebook", kind: "mention", text: "Grabbed breakfast at Harbour Bakery, so good", authorName: "Jo Park", status: "done", receivedAt: iso(now - 3 * 86400_000), repliedAt: iso(now - 3 * 86400_000 + 600_000), assigneeId: "u_sam", assigneeName: "Sam Lee" }),
  ];
  const notes: Record<string, InboxNoteView[]> = {
    si_3: [{ id: "sn_1", kind: "note", text: "Regular customer, usually orders the seeded loaf.", authorId: "u_ana", authorName: "Ana Ruiz", status: "sent", error: null, createdAt: iso(now - 20 * 3600_000) }],
  };
  const sources: InboxSourceView[] = [
    { accountId: "ca_fb", app: "facebook", label: "Harbour Bakery", state: "ok", text: null, syncedAt: iso(now - 60_000) },
    { accountId: "ca_ig", app: "instagram", label: "@harbourbakery", state: "error", text: "Sign in expired. Reconnect to keep messages coming in.", syncedAt: iso(now - 86400_000) },
    { accountId: "ca_li", app: "linkedin", label: "Sam Lee", state: "posting_only", text: "Posting only.", syncedAt: null },
  ];
  const saved: SavedReplyView[] = [
    { id: "sr_1", title: "Thanks", body: "Thanks {name}, glad you liked it!" },
    { id: "sr_2", title: "Opening hours", body: "Hi {name}, we're open 7 am to 3 pm, Tuesday to Sunday." },
  ];
  const people = [{ id: "u_sam", name: "Sam Lee" }, { id: "u_ana", name: "Ana Ruiz" }];
  return { accounts, posts, direct, inbox, notes, sources, saved, people, me: "u_sam", seq: 10, sendAt: {} as Record<string, number> };
}

export type SampleSocial = ReturnType<typeof sampleSocial>;

/** Answers the social paths, or undefined when the path is not one of them. */
export function socialRoute(s: SampleSocial, method: string, path: string, body: unknown, now: number): unknown {
  if (path === "/apps/status" && method === "GET") return { available: true, canManage: true };
  if (path === "/apps/accounts" && method === "GET") return { accounts: s.accounts };
  if (path === "/direct/status" && method === "GET") return s.direct;
  if (path === "/social/health" && method === "GET") return { accounts: s.accounts.map((a) => ({ accountId: a.id, app: a.app, ok: a.status === "active", code: a.status === "active" ? null : "reconnect", text: null })) };
  if (path === "/social/posts" && method === "GET") return { posts: s.posts };
  const inbox = inboxRoute(s, method, path, body, now);
  if (inbox !== undefined) return inbox;
  if (path === "/apps/connect" || /^\/apps\/accounts\/[^/]+\/(reconnect|confirm)$/.test(path)) {
    throw new ApiError(403, "sample", "Connecting accounts needs your real workspace. Sign in to connect.");
  }
  const t = path.match(/^\/apps\/accounts\/([^/]+)\/targets$/);
  if (t && method === "GET") return { targets: t[1] === "ca_fb" ? [{ id: "pg_1", name: "Harbour Bakery" }, { id: "pg_2", name: "Harbour Bakery Events" }] : [] };
  if (path === "/social/posts" && method === "POST") {
    const b = body as NewSocialPost;
    const later = b.runAt && Date.parse(b.runAt) > now;
    const post: SocialPostView = {
      id: `sp_${++s.seq}`, text: b.text, imageUrl: b.image ? `data:${b.image.contentType};base64,${b.image.dataB64}` : null, status: "scheduled", runAt: b.runAt ?? new Date(now).toISOString(), createdAt: new Date(now).toISOString(), createdBy: "You",
      targets: b.targets.map((x) => {
        const a = s.accounts.find((acc) => acc.id === x.accountId);
        const app = a?.app ?? "facebook";
        return { accountId: x.accountId, app, label: a?.label ?? null, target: x.target ?? null, targetName: x.targetName ?? null, status: "pending", url: null, error: null, sentAt: null, networkState: null, checkedAt: null, canCheck: app === "facebook", canDelete: app === "facebook" || app === "linkedin" };
      }),
    };
    // A post set for now goes out a moment after it is saved, as on the server, so the phone shows "Posting now" first.
    if (!later) s.sendAt[post.id] = now + 2500;
    s.posts.unshift(post);
    return { post };
  }
  for (const p of s.posts) {
    const at = s.sendAt[p.id];
    if (at && at <= now) {
      delete s.sendAt[p.id];
      p.targets = p.targets.map((x) => ({ ...x, status: "sent", sentAt: new Date(now).toISOString(), url: x.app === "facebook" ? "https://www.facebook.com/" : x.app === "linkedin" ? "https://www.linkedin.com/" : null, networkState: x.canCheck ? "live" : null }));
      p.status = "done";
    }
  }
  const one = path.match(/^\/social\/posts\/([^/]+)$/);
  if (one && method === "GET") {
    const p = s.posts.find((x) => x.id === one[1]);
    if (!p) throw new ApiError(404, "not_found", "That post is gone.");
    return { post: p };
  }
  if (path === "/social/posts/sync" && method === "POST") {
    const ids = new Set((body as { ids?: string[] })?.ids ?? []);
    const out = s.posts.filter((p) => ids.has(p.id));
    for (const p of out) p.targets = p.targets.map((x) => (x.canCheck && x.status === "sent" ? { ...x, checkedAt: new Date(now).toISOString() } : x));
    return { posts: out };
  }
  if (one && method === "DELETE") {
    const i = s.posts.findIndex((x) => x.id === one[1]);
    if (i < 0) throw new ApiError(404, "not_found", "That post is gone.");
    const p = s.posts[i]!;
    const results = p.targets.map((x) => ({ accountId: x.accountId, app: x.app, outcome: x.status !== "sent" ? "not_sent" as const : x.networkState === "removed" ? "already_gone" as const : x.canDelete ? "deleted" as const : "not_supported" as const }));
    s.posts.splice(i, 1);
    return { deleted: true, results, post: null };
  }
  const m = path.match(/^\/social\/posts\/([^/]+)\/(retry|cancel)$/);
  if (m && method === "POST") {
    const p = s.posts.find((x) => x.id === m[1]);
    if (!p) throw new ApiError(404, "not_found", "Post not found.");
    if (m[2] === "cancel") p.status = "canceled";
    else { p.targets = p.targets.map((x) => (x.status === "failed" ? { ...x, status: "sent", error: null, sentAt: new Date(now).toISOString() } : x)); p.status = "done"; }
    return { post: p };
  }
  return undefined;
}

/** 1.10.8: the Social inbox paths, with the server's rules for assigning and the reply window. */
function inboxRoute(s: SampleSocial, method: string, fullPath: string, body: unknown, now: number): unknown {
  const [path, qs = ""] = fullPath.split("?");
  if (!path!.startsWith("/social/inbox") && path !== "/social/saved-replies") return undefined;
  if (path === "/social/saved-replies" && method === "GET") return { replies: s.saved };
  if (path === "/social/inbox/sync" && method === "POST") { for (const x of s.sources) if (x.state === "ok") x.syncedAt = new Date(now).toISOString(); return { ok: true }; }
  if (path === "/social/inbox" && method === "GET") {
    const q = new URLSearchParams(qs);
    const status = q.get("status") === "done" ? "done" : "open";
    const view = q.get("view");
    const items = s.inbox.filter((x) => x.status === status && (view === "mine" ? x.assigneeId === s.me : view === "unassigned" ? !x.assigneeId : true));
    const open = s.inbox.filter((x) => x.status === "open");
    return {
      items, sources: s.sources, syncedAt: new Date(now - 60_000).toISOString(), stale: false, canManage: true, test: false, me: s.me, people: s.people,
      counts: { open: open.length, mine: open.filter((x) => x.assigneeId === s.me).length, unassigned: open.filter((x) => !x.assigneeId).length, done: s.inbox.length - open.length },
    };
  }
  const m = path!.match(/^\/social\/inbox\/([^/]+)(?:\/(notes|reply|task))?$/);
  if (!m) return undefined;
  const it = s.inbox.find((x) => x.id === m[1]);
  if (!it) throw new ApiError(404, "not_found", "That conversation is gone.");
  const iso = new Date(now).toISOString();
  if (!m[2] && method === "GET") return { item: it, notes: s.notes[it.id] ?? [] };
  if (!m[2] && method === "PATCH") {
    const b = (body ?? {}) as { status?: "open" | "done"; assigneeId?: string | null };
    if (b.status) it.status = b.status;
    if (b.assigneeId !== undefined) { it.assigneeId = b.assigneeId; it.assigneeName = s.people.find((p) => p.id === b.assigneeId)?.name ?? null; }
    return { item: it };
  }
  const text = String((body as { text?: string })?.text ?? "").trim();
  if (m[2] === "notes" && method === "POST") {
    if (!text) throw new ApiError(400, "empty", "Write a note first.");
    const note: InboxNoteView = { id: `sn_${++s.seq}`, kind: "note", text, authorId: s.me, authorName: "Sam Lee", status: "sent", error: null, createdAt: iso };
    (s.notes[it.id] ??= []).push(note);
    return { note };
  }
  if (m[2] === "reply" && method === "POST") {
    if (!text) throw new ApiError(400, "empty", "Write a reply first.");
    if (replyWindow(it.app, it.kind, it.lastInboundAt, now).state === "closed") throw new ApiError(422, "window_closed", "The reply window has closed. The network only takes replies within 24 hours of their last message.");
    const note: InboxNoteView = { id: `sn_${++s.seq}`, kind: "reply", text, authorId: s.me, authorName: "Sam Lee", status: "sent", error: null, createdAt: iso };
    (s.notes[it.id] ??= []).push(note);
    it.repliedAt = iso;
    if (!it.assigneeId) { it.assigneeId = s.me; it.assigneeName = "Sam Lee"; }
    return { note, item: it };
  }
  if (m[2] === "task" && method === "POST") { it.taskId ??= `t_${++s.seq}`; return { taskId: it.taskId, item: it }; }
  return undefined;
}
