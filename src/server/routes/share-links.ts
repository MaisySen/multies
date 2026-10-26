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
    return c.html(sharePage(share), 200, headers);
  });
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

export function sharePage(s: PublicShare) {
  const top = `<header class="top"><span class="brand">Multies</span>${s.workspace ? `<span class="ws">Shared by ${esc(s.workspace)}</span>` : ""}<span class="ro">Read only</span></header>`;
  if (s.kind === "doc") {
    return page(s.title || "Shared doc", `${top}<main class="doc"><h1>${esc(s.title || "Untitled")}</h1><article>${s.html}</article></main>`);
  }
  const cols = s.columns.map((col) => `<section class="col" aria-label="${esc(col.name)}"><h2><span class="dot" style="background:${safeColor(col.color)}"></span>${esc(col.name)}<span class="n">${col.cards.length}</span></h2>${col.cards.map((t) =>
    `<div class="card"><p class="t">${esc(t.title)}</p>${t.labels.length ? `<p class="labels">${t.labels.map((l) => `<span>${esc(l)}</span>`).join("")}</p>` : ""}<p class="meta">${t.due ? `<span class="due">${esc(dueLabel(t.due))}</span>` : "<span></span>"}${t.assignee ? `<span class="who" title="Assignee">${esc(t.assignee)}</span>` : ""}</p></div>`).join("")}</section>`).join("");
  return page(s.title, `${top}<main class="board"><h1><span class="sq" style="background:${safeColor(s.color)}"></span>${esc(s.title)}</h1><div class="cols">${cols}</div>${s.truncated ? `<p class="more">Showing the first 500 cards.</p>` : ""}</main>`);
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)} | Multies</title><style>${CSS}</style></head><body>${body}</body></html>`;
}

const CSS = `
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
