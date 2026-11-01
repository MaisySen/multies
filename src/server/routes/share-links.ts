/**
 * R26 (MB-87): share links in the web app (cookie session) and the public page.
 *   POST   /api/share-links            { kind: doc | project_board, targetId, expiresInDays?: 7 | 30 | null, showWorkspaceName? }
 *   GET    /api/share-links            ?kind=&targetId= (active links, newest first)
 *   DELETE /api/share-links/:id        revoke
 *   GET    /api/share-links/settings   { allowShareLinks }
 *   PUT    /api/share-links/settings   { allowShareLinks } (admins)
 *   GET    /s/:token                   the read only page, no sign in
 * The same service backs the public API (v1-r26-share.ts) and the MCP tools (mcp-r26-share.ts).
 */
import { addPublicComment, publicThread, type PublicThread } from "../services/docs-plus/comments"; // R103
import { formToken, publicPostOk } from "../services/tools/p2-public"; // R103
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { RateLimiter } from "../lib/rate-limit";
import { tooMany } from "../lib/errors";
import { createShareLink, listShareLinks, publicShare, revokeShareLink, setShareLinksAllowed, shareLinksAllowed, type PublicShare } from "../services/suite/share-links";

export const ShareCreateBody = z.object({
  kind: z.enum(["doc", "project_board"]),
  targetId: z.string().min(1).max(64),
  expiresInDays: z.union([z.literal(7), z.literal(30)]).nullable().optional(),
  showWorkspaceName: z.boolean().optional(),
});
export const ShareListQuery = z.object({ kind: z.enum(["doc", "project_board"]).optional(), targetId: z.string().min(1).max(64).optional() });
const SettingsBody = z.object({ allowShareLinks: z.boolean() });

export function shareLinkRoutes() {
  // The same budget as invitations: 60 new links an hour per person, in memory (no write).
  const limiter = new RateLimiter(60, 60 * 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/settings", async (c) => c.json({ allowShareLinks: await shareLinksAllowed(c.var.deps, c.var.auth.orgId) }))
    .put("/settings", async (c) => c.json(await setShareLinksAllowed(c.var.deps, c.var.auth, (await parseBody(c, SettingsBody)).allowShareLinks)))
    .get("/", async (c) => {
      const q = ShareListQuery.safeParse({ kind: c.req.query("kind") || undefined, targetId: c.req.query("targetId") || undefined });
      return c.json(await listShareLinks(c.var.deps, c.var.auth, q.success ? q.data : {}));
    })
    .post("/", async (c) => {
      const input = await parseBody(c, ShareCreateBody);
      if (!limiter.take(c.var.auth.userId)) throw tooMany("Too many share links in the last hour.");
      const { link } = await createShareLink(c.var.deps, c.var.auth, input);
      return c.json({ link }, 201);
    })
    .delete("/:id", async (c) => c.json(await revokeShareLink(c.var.deps, c.var.auth, c.req.param("id"))));
}

/** The public page. 60 opens a minute per IP, counted in memory, so an open writes nothing. */
export function sharePageRoutes() {
  const limiter = new RateLimiter(60, 60_000);
  return new Hono<AppEnv>().get("/:token", async (c) => {
    const headers = { "cache-control": "private, max-age=0", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
    if (!limiter.take(c.var.ip)) return c.html(page("Too many requests", `<main class="gone"><h1>Too many requests</h1><p>Try again in a minute.</p></main>`), 429, { ...headers, "retry-after": "60" });
    const share = await publicShare(c.var.deps, c.req.param("token"));
    if (!share) return c.html(inactivePage(), 404, headers);
    // R103: approved comments and the comment form, when the link has comments on (DOCS_PLUS_R103=on).
    let extra = "";
    if (share.kind === "doc" && c.var.deps.config.docsPlus) {
      const t = await publicThread(c.var.deps, c.req.param("token"));
      if (t) extra = commentsSection(t, await formToken(c, "doccomment", t.tokenHash), c.req.query("sent") === "1" ? "sent" : null, c.req.param("token"));
    }
    return c.html(sharePage(share, extra), 200, headers);
  }).post("/:token/comments", async (c) => {
    // R103: a visitor's comment. Same site form posts only, a form token, 5 a minute per IP; it waits for review.
    const headers = { "cache-control": "private, max-age=0", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
    if (!c.var.deps.config.docsPlus) return c.html(inactivePage(), 404, headers);
    const token = c.req.param("token");
    const t = await publicThread(c.var.deps, token);
    if (!t) return c.html(inactivePage(), 404, headers);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
    const back = (msg: string, status: 400 | 422 | 429) => c.html(page("Comment not sent", `<main class="gone"><h1>Comment not sent</h1><p>${esc(msg)}</p><p><a href="/s/${esc(token)}#comments">Back to the page</a></p></main>`), status, headers);
    if (!(await publicPostOk(c, "doccomment", t.tokenHash, str("ft")))) return back("This form has expired. Open the page again and retry.", 400);
    if (str("website")) return c.redirect(`/s/${token}?sent=1#comments`, 303); // filled by bots only
    if (!commentLimiter.take(c.var.ip)) return back("Too many comments from here. Try again in a minute.", 429);
    try {
      await addPublicComment(c.var.deps, t, { name: str("name"), email: str("email"), body: str("body") });
    } catch (e) {
      const err = e as { status?: number; message?: string };
      return back(err.message || "That did not work. Try again.", err.status === 429 ? 429 : 422);
    }
    return c.redirect(`/s/${token}?sent=1#comments`, 303);
  });
}

const commentLimiter = new RateLimiter(5, 60_000);

/** R103: the comments block under a shared doc (server rendered, no scripts). */
export function commentsSection(t: PublicThread, ft: string, note: "sent" | null, token = "") {
  const when = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const list = t.comments.length
    ? `<ol class="cm-list">${t.comments.map((x) => `<li class="cm"><p class="cm-by"><strong>${esc(x.name)}</strong>${x.team ? ` <span class="cm-team">Team</span>` : ""} <span class="cm-when">${when(x.createdAt)}</span></p><p class="cm-body">${esc(x.body).replace(/\n/g, "<br>")}</p></li>`).join("")}</ol>`
    : `<p class="cm-empty">No comments yet. Be the first to add one.</p>`;
  const sent = note === "sent" ? `<p class="cm-note" role="status">Thanks. Your comment shows here once the team reviews it.</p>` : "";
  return `<section id="comments" class="cm-wrap" aria-labelledby="cm-h"><h2 id="cm-h">Comments</h2>${sent}${list}
<form class="cm-form" method="post" action="/s/${esc(token)}/comments" data-r103="comment-form"><h3>Add a comment</h3><p class="cm-hint">Comments are reviewed before they show. Your email is never shown.</p>
<input type="hidden" name="ft" value="${esc(ft)}"><div class="cm-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
<label for="cm-name">Name</label><input id="cm-name" name="name" required maxlength="80" autocomplete="name">
<label for="cm-email">Email (optional)</label><input id="cm-email" name="email" type="email" maxlength="200" autocomplete="email">
<label for="cm-body">Comment</label><textarea id="cm-body" name="body" required maxlength="4000" rows="4"></textarea>
<button type="submit">Send comment</button></form></section>`;
}

export const INACTIVE_TEXT = "This link is no longer active";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const safeColor = (c: string) => (/^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "#8a8f98");

export function inactivePage() {
  return page(INACTIVE_TEXT, `<main class="gone"><h1>${INACTIVE_TEXT}</h1><p>Ask the person who sent it for a new one.</p></main>`);
}

function dueLabel(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function sharePage(s: PublicShare, extra = "") {
  const top = `<header class="top"><span class="brand">Multies</span>${s.workspace ? `<span class="ws">Shared by ${esc(s.workspace)}</span>` : ""}<span class="ro">Read only</span></header>`;
  if (s.kind === "doc") {
    return page(s.title || "Shared doc", `${top}<main class="doc"><h1>${esc(s.title || "Untitled")}</h1><article>${s.html}</article>${extra}</main>`);
  }
  const cols = s.columns.map((col) => `<section class="col" aria-label="${esc(col.name)}"><h2><span class="dot" style="background:${safeColor(col.color)}"></span>${esc(col.name)}<span class="n">${col.cards.length}</span></h2>${col.cards.map((t) =>
    `<div class="card"><p class="t">${esc(t.title)}</p>${t.labels.length ? `<p class="labels">${t.labels.map((l) => `<span>${esc(l)}</span>`).join("")}</p>` : ""}<p class="meta">${t.due ? `<span class="due">${esc(dueLabel(t.due))}</span>` : "<span></span>"}${t.assignee ? `<span class="who" title="Assignee">${esc(t.assignee)}</span>` : ""}</p></div>`).join("")}</section>`).join("");
  return page(s.title, `${top}<main class="board"><h1><span class="sq" style="background:${safeColor(s.color)}"></span>${esc(s.title)}</h1><div class="cols">${cols}</div>${s.truncated ? `<p class="more">Showing the first 500 cards.</p>` : ""}</main>`);
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)} | Multies</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

const CSS = `
.cm-wrap{margin-top:48px;border-top:1px solid #e3e5e8;padding-top:24px}.cm-wrap h2{font-size:20px;margin:0 0 16px}.cm-list{list-style:none;padding:0;margin:0 0 24px}
.cm{padding:12px 0;border-bottom:1px solid #eef0f2}.cm-by{margin:0 0 4px;font-size:14px}.cm-when{color:#5f6672;font-size:13px}.cm-team{font-size:12px;border:1px solid #c9ced6;border-radius:6px;padding:0 6px}
.cm-body{margin:0;white-space:normal;overflow-wrap:anywhere}.cm-empty,.cm-hint{color:#5f6672;font-size:14px}.cm-note{background:#eef7f0;border:1px solid #b9dcc2;border-radius:8px;padding:8px 12px}
.cm-form{display:grid;gap:8px;max-width:560px}.cm-form h3{font-size:16px;margin:0}.cm-form label{font-size:14px;font-weight:600}
.cm-form input,.cm-form textarea{font:inherit;border:1px solid #c9ced6;border-radius:8px;padding:10px 12px;min-height:44px;width:100%;box-sizing:border-box;background:#fff;color:#14171c}
.cm-form input:focus-visible,.cm-form textarea:focus-visible,.cm-form button:focus-visible{outline:2px solid #2f6fde;outline-offset:2px}
.cm-form button{justify-self:start;min-height:44px;padding:0 18px;border-radius:8px;border:0;background:#1f6f43;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.cm-hp{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
@media (prefers-color-scheme:dark){.cm-wrap{border-color:#2a2f37}.cm{border-color:#22262d}.cm-when,.cm-empty,.cm-hint{color:#a3abb7}.cm-form input,.cm-form textarea{background:#14171c;color:#e8eaee;border-color:#3a414c}.cm-note{background:#14301f;border-color:#2c5a3a}}

:root{color-scheme:light dark;--bg:#f5f5f7;--fg:#1d1d1f;--muted:#6e6e73;--line:#d2d2d7;--card:#fff;--brand:#0071E3}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--muted:#a1a1a6;--line:#38383a;--card:#1c1c1e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--card) 80%,transparent);position:sticky;top:0;backdrop-filter:saturate(180%) blur(20px)}
.brand{font-weight:600;color:var(--brand);letter-spacing:-.01em}.ws{color:var(--muted);font-size:13px}.ro{margin-left:auto;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px}
main.doc{max-width:720px;margin:0 auto;padding:40px 24px 80px}main.doc h1{font-size:32px;line-height:1.15;letter-spacing:-.02em;margin:0 0 20px}
article h1,article h2,article h3,article h4{letter-spacing:-.01em;line-height:1.25;margin:1.4em 0 .5em}article p{margin:.6em 0}article a{color:var(--brand)}
article blockquote{margin:1em 0;padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}article pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto}
article code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}article hr{border:0;border-top:1px solid var(--line);margin:2em 0}
ul.tasks{list-style:none;padding-left:0}ul.tasks li{display:flex;gap:8px;align-items:flex-start}ul.tasks .box{flex:none;width:15px;height:15px;margin-top:4px;border:1.5px solid var(--muted);border-radius:4px}ul.tasks li.done .box{background:var(--brand);border-color:var(--brand)}ul.tasks li.done>div{color:var(--muted);text-decoration:line-through}ul.tasks li>div>p{margin:0}
main.board{padding:28px 24px 60px}main.board h1{display:flex;align-items:center;gap:10px;font-size:26px;letter-spacing:-.02em;margin:0 0 20px}.sq{width:14px;height:14px;border-radius:4px}
.cols{display:flex;gap:16px;overflow-x:auto;align-items:flex-start;padding-bottom:8px}.col{flex:0 0 280px;background:color-mix(in srgb,var(--line) 35%,transparent);border-radius:14px;padding:10px}
.col h2{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;margin:4px 6px 10px}.dot{width:8px;height:8px;border-radius:50%}.n{margin-left:auto;color:var(--muted);font-weight:500}
.card{background:var(--card);border-radius:10px;padding:10px 12px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,.06)}.card .t{margin:0;font-weight:500;font-size:14px}
.labels{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 0}.labels span{font-size:11px;background:color-mix(in srgb,var(--brand) 12%,transparent);color:var(--brand);border-radius:6px;padding:1px 7px}
.meta{display:flex;justify-content:space-between;align-items:center;margin:8px 0 0;font-size:12px;color:var(--muted)}.who{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--brand);color:#fff;font-size:10.5px;font-weight:600}
.more{color:var(--muted);font-size:13px}main.gone{max-width:460px;margin:18vh auto;padding:0 24px;text-align:center}main.gone h1{font-size:24px;letter-spacing:-.02em}main.gone p{color:var(--muted)}
article .table{overflow-x:auto;margin:1em 0}article table{width:100%;border-collapse:separate;border-spacing:0;border:1px solid var(--line);border-radius:10px;overflow:hidden}article th,article td{padding:6px 10px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);text-align:left;vertical-align:top}article tr>*:last-child{border-right:0}article tr:last-child>*{border-bottom:0}article th{background:color-mix(in srgb,var(--line) 40%,transparent);font-weight:600}article td>p,article th>p{margin:0}
article .callout{margin:1em 0;padding:10px 14px;border-radius:12px;background:color-mix(in srgb,var(--brand) 9%,transparent);border:1px solid color-mix(in srgb,var(--brand) 20%,transparent)}article .callout[data-callout=success]{background:rgba(36,138,61,.12);border-color:rgba(36,138,61,.25)}article .callout[data-callout=warning]{background:rgba(255,159,10,.16);border-color:rgba(255,159,10,.3)}article .callout[data-callout=danger]{background:rgba(215,0,21,.1);border-color:rgba(215,0,21,.22)}article .callout>p{margin:.3em 0}
article img{display:block;max-width:100%;height:auto;border-radius:10px;margin:1em auto}article img[data-size=fit]{max-width:min(100%,560px)}article img[data-size=wide],article img[data-size=full]{width:100%}article .img-missing{color:var(--muted);font-style:italic}
`;
