import { ApiError } from "@/api/errors";
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
  return { accounts, posts, direct, seq: 10, sendAt: {} as Record<string, number> };
}

export type SampleSocial = ReturnType<typeof sampleSocial>;

/** Answers the social paths, or undefined when the path is not one of them. */
export function socialRoute(s: SampleSocial, method: string, path: string, body: unknown, now: number): unknown {
  if (path === "/apps/status" && method === "GET") return { available: true, canManage: true };
  if (path === "/apps/accounts" && method === "GET") return { accounts: s.accounts };
  if (path === "/direct/status" && method === "GET") return s.direct;
  if (path === "/social/health" && method === "GET") return { accounts: s.accounts.map((a) => ({ accountId: a.id, app: a.app, ok: a.status === "active", code: a.status === "active" ? null : "reconnect", text: null })) };
  if (path === "/social/posts" && method === "GET") return { posts: s.posts };
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
