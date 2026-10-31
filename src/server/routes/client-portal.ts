/**
 * R120: client portals (flag CLIENT_PORTAL=on; off: every route here answers 404).
 *   Signed in (workspace):
 *     GET    /api/portals                       ?contactId= | ?companyId=   portals, newest activity first
 *     POST   /api/portals                       { contactId | companyId, name?, welcome? }  (one live portal each; asking again answers it)
 *     GET    /api/portals/:id                   portal, people, shared items, messages (reading marks client messages seen)
 *     PATCH  /api/portals/:id                   { name?, welcome?, showBrand?, archived? }
 *     POST   /api/portals/:id/people            { email, name? }      DELETE /api/portals/:id/people/:pid
 *     POST   /api/portals/:id/people/:pid/invite   email the sign in link     POST .../link   a one time link to copy
 *     POST   /api/portals/:id/files             raw bytes, x-multies-upload: 1, x-file-name (URI encoded), x-folder
 *     POST   /api/portals/:id/items             { kind: doc | task, refId }   POST /api/portals/:id/requests { title, message? }
 *     DELETE /api/portals/:id/items/:itemId     GET /api/portals/:id/files/:itemId (download)
 *     POST   /api/portals/:id/messages          { body }
 *   Public (the client's own session cookie, path /p/<key>, never the app's):
 *     GET /p/<key>[?tab=]  sign in page or the space   POST /p/<key>/login { email }   GET|POST /p/<key>/in/<token>
 *     GET /p/<key>/f/<item> download   GET /p/<key>/d/<item> doc   POST /p/<key>/messages { body }   POST /p/<key>/out
 */
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError, notFound, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { toolFeatureOn } from "../services/tools/features";
import { readToolState, toolsOnFor } from "../services/tools/usage";
import { PUBLIC_HEADERS, attachmentDisposition, esc, formToken, publicPage, publicPostOk, sizeText } from "../services/tools/p2-public";
import { renderDocHtml } from "../services/suite/share-links";
import { getBrand } from "./branding";
import { whiteContrast } from "./secure-share";
import { logoUrl, pickLogo } from "@/shared/branding";
import {
  addFile, addPerson, addRequest, addShared, clientData, clientDoc, clientFile, clientFromSession, clientMessage, copyLink, createPortal, endClientSession,
  invitePerson, listPortals, portalByKey, portalDetail, removeItem, removePerson, requestClientLink, teamFile, teamMessage, updatePortal, useClientLink,
  type PortalRow,
} from "../services/portal/client-portal";
import { PORTAL_SESSION_DAYS, taskStateLabel } from "@/shared/client-portal";

const on = (c: Context<AppEnv>) => !!c.var.deps.config.clientPortal;
const MAX_FILE = 25 * 1024 * 1024;

/** File requests in a portal need Tools and its file requests feature on for the workspace. */
async function requestsOn(c: Context<AppEnv>): Promise<boolean> {
  if (!toolFeatureOn(c, "file_requests")) return false;
  const s = await readToolState(c.var.deps.db, c.var.auth.orgId, c.var.deps.now()).catch(() => null);
  return !!s && toolsOnFor(s);
}

const CreateBody = z.object({ contactId: z.string().max(64).nullable().optional(), companyId: z.string().max(64).nullable().optional(), name: z.string().max(200).nullable().optional(), welcome: z.string().max(2000).nullable().optional() });
const PatchBody = z.object({ name: z.string().max(200).optional(), welcome: z.string().max(2000).nullable().optional(), showBrand: z.boolean().optional(), archived: z.boolean().optional() });
const PersonBody = z.object({ email: z.string().max(254), name: z.string().max(200).nullable().optional() });
const ItemBody = z.object({ kind: z.enum(["doc", "task"]), refId: z.string().min(1).max(64) });
const RequestBody = z.object({ title: z.string().max(200), message: z.string().max(2000).nullable().optional() });
const MessageBody = z.object({ body: z.string().max(5000) });

export function portalRoutes() {
  const links = new RateLimiter(30, 60 * 60_000); // sign in links a team member can send or copy in an hour
  const creates = new RateLimiter(60, 60 * 60_000);
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!on(c)) throw notFound("Page"); await next(); })
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ portals: await listPortals(c.var.deps, c.var.auth, { contactId: c.req.query("contactId") || undefined, companyId: c.req.query("companyId") || undefined }) }))
    .post("/", async (c) => {
      if (!creates.take(c.var.auth.userId)) throw tooMany("Too many new portals in the last hour.");
      const r = await createPortal(c.var.deps, c.var.auth, await parseBody(c, CreateBody));
      return c.json(r, r.existing ? 200 : 201);
    })
    .get("/:id", async (c) => c.json(await portalDetail(c.var.deps, c.var.auth, c.req.param("id"), await requestsOn(c))))
    .patch("/:id", async (c) => c.json({ portal: await updatePortal(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PatchBody)) }))
    .post("/:id/people", async (c) => c.json({ person: await addPerson(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PersonBody)) }, 201))
    .delete("/:id/people/:pid", async (c) => c.json(await removePerson(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("pid"))))
    .post("/:id/people/:pid/invite", async (c) => {
      if (!links.take(c.var.auth.userId)) throw tooMany("Too many sign in links in the last hour.");
      return c.json(await invitePerson(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("pid")));
    })
    .post("/:id/people/:pid/link", async (c) => {
      if (!links.take(c.var.auth.userId)) throw tooMany("Too many sign in links in the last hour.");
      return c.json(await copyLink(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("pid")));
    })
    .post("/:id/files", async (c) => {
      const len = Number(c.req.header("content-length") ?? "0");
      if (len > MAX_FILE + 1024) throw new HttpError(413, "too_large", "Files can be up to 25 MB here.");
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > MAX_FILE) throw new HttpError(413, "too_large", "Files can be up to 25 MB here.");
      let name = "file";
      try { name = decodeURIComponent(c.req.header("x-file-name") ?? "file"); } catch { /* keep the default */ }
      let folder: string | null;
      try { folder = decodeURIComponent(c.req.header("x-folder") ?? "") || null; } catch { folder = null; }
      return c.json(await addFile(c.var.deps, c.var.auth, c.req.param("id"), { name, type: c.req.header("content-type") ?? null, folder, bytes }), 201);
    })
    .get("/:id/files/:itemId", async (c) => {
      const f = await teamFile(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"));
      return c.body(f.bytes as Uint8Array<ArrayBuffer>, 200, { "content-type": f.type, "content-disposition": attachmentDisposition(f.name), "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    })
    .post("/:id/items", async (c) => c.json(await addShared(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ItemBody)), 201))
    .post("/:id/requests", async (c) => {
      if (!(await requestsOn(c))) throw new HttpError(400, "requests_off", "Turn on Tools for this workspace to ask for files.");
      return c.json(await addRequest(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, RequestBody)), 201);
    })
    .delete("/:id/items/:itemId", async (c) => c.json(await removeItem(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"))))
    .post("/:id/messages", async (c) => c.json({ message: await teamMessage(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, MessageBody)).body) }, 201));
}

// ---- public pages ----

const COOKIE = "mp_portal";
const TABS = [["home", "Overview"], ["files", "Files"], ["docs", "Docs"], ["tasks", "Tasks"], ["messages", "Messages"]] as const;
type Tab = (typeof TABS)[number][0];

const PAGE_CSS = `<style>
.ws-name{color:var(--fg)}.logo{max-height:32px;max-width:180px}.top .out{margin-left:auto}
main.portal{max-width:880px;margin:3vh auto}.lead{color:var(--muted);margin:0 0 4px}
nav.ptabs{display:flex;gap:4px;overflow-x:auto;margin:18px 0 16px;border-bottom:1px solid var(--line);scrollbar-width:none}
nav.ptabs a{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;color:var(--muted);text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap;font-size:14px}
nav.ptabs a[aria-current=page]{color:var(--fg);border-bottom-color:var(--brand);font-weight:600}nav.ptabs a:hover{color:var(--fg)}
.list{list-style:none;margin:0;padding:0}.list li{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.list li:first-child{border-top:0}
.grow{flex:1;min-width:0}.t{font-weight:500;overflow-wrap:anywhere}.meta{color:var(--muted);font-size:13px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12.5px;white-space:nowrap}.pill.done{color:var(--good);border-color:currentColor}.pill.doing{color:var(--brand);border-color:currentColor}
a.act,button.act{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:14px;text-decoration:none;cursor:pointer;white-space:nowrap}
a.act:hover,button.act:hover{border-color:var(--muted)}a.act.primary,button.act.primary{background:var(--brand);border-color:var(--brand);color:#fff}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.sec-h{font-size:13px;font-weight:600;color:var(--muted);text-transform:none;margin:18px 0 6px}.sec-h:first-child{margin-top:0}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:16px}.stat{border:1px solid var(--line);border-radius:12px;padding:14px;text-decoration:none;color:var(--fg)}.stat b{display:block;font-size:22px}.stat span{color:var(--muted);font-size:13px}
.thread{display:flex;flex-direction:column;gap:10px;margin:0 0 16px;padding:0;list-style:none}.bubble{max-width:80%;padding:10px 14px;border-radius:14px;border:1px solid var(--line);white-space:pre-wrap;overflow-wrap:anywhere}
.bubble.me{align-self:flex-end;background:var(--brand);border-color:var(--brand);color:#fff}.bubble .who{font-size:12px;opacity:.8;margin-bottom:2px}
label{display:block;font-size:14px;font-weight:500;margin:0 0 6px}input[type=email],textarea{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg)}textarea{min-height:96px;resize:vertical}
.form-row{display:flex;gap:10px;align-items:flex-end;margin-top:10px}.form-row .grow{flex:1}.empty{color:var(--muted);text-align:center;padding:28px 8px}
article.doc{line-height:1.65}article.doc img{max-width:100%}article.doc pre{overflow-x:auto}article.doc table{display:block;overflow-x:auto}
.center{text-align:center}.small{font-size:13px}
@media (max-width:600px){main.portal{margin-top:12px}.grid3{grid-template-columns:1fr}.bubble{max-width:92%}.list li{flex-wrap:wrap}.list li .act{width:100%}}
@media (prefers-reduced-motion:no-preference){a.act,button.act,nav.ptabs a{transition:border-color .15s,color .15s}}
</style>`;

async function brand(c: Context<AppEnv>, p: PortalRow, workspace: string) {
  const ws = esc(workspace);
  if (!p.show_brand) return { head: `<span class="brand">${ws}</span>`, style: "" };
  const b = await getBrand(c.var.deps.db, p.org_id).catch(() => null);
  const kind = b ? pickLogo(b, "wide", "light") ?? pickLogo(b, "mark", "light") : null;
  const logo = b && kind ? `<img class="logo" src="${esc(logoUrl(p.org_id, kind, b.logos[kind]!))}" alt="${ws}">` : "";
  const colour = b?.primary && /^#[0-9a-fA-F]{6}$/.test(b.primary) && whiteContrast(b.primary) >= 4.5 ? b.primary : null;
  return { head: logo || `<span class="brand ws-name">${ws}</span>`, style: colour ? `<style>:root{--brand:${colour}}</style>` : "" };
}

async function wsName(c: Context<AppEnv>, p: PortalRow) {
  return (await c.var.deps.db.get<{ name: string }>(sql`select name from organizations where id = ${p.org_id}`))?.name ?? "";
}

const dateText = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function plain(title: string, body: string, status = 200) {
  return { html: publicPage(title, `${PAGE_CSS}<header class="top"><span class="brand">Multies</span></header><main><div class="card center"><h1>${esc(title)}</h1><p class="muted">${esc(body)}</p></div></main>`), status };
}

const secure = (c: Context<AppEnv>) => c.var.deps.config.appUrl.startsWith("https:");
const cookiePath = (p: PortalRow) => `/p/${p.key}`;

async function signInPage(c: Context<AppEnv>, p: PortalRow, note: string | null, status: 200 | 403 | 410 = 200) {
  const ws = await wsName(c, p);
  const { head, style } = await brand(c, p, ws);
  const ft = await formToken(c, "portal", p.id);
  return c.html(publicPage(p.name, `${style}${PAGE_CSS}<header class="top">${head}</header>
<main><div class="card" data-testid="portal-signin"><h1>${esc(p.name)}</h1>
<p class="muted">${esc(ws || "Your team")} shares files, updates and messages with you here. Enter your email and we will send you a link to sign in. No password needed.</p>
${note ? `<p role="status" class="ok" data-testid="portal-signin-note">${esc(note)}</p>` : ""}
<form method="post" action="/p/${esc(p.key)}/login"><input type="hidden" name="ft" value="${ft}">
<label for="email">Your email</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="email" data-testid="portal-email">
<div class="form-row"><button class="act primary grow" type="submit" data-testid="portal-send-link">Email me a sign in link</button></div></form>
<p class="muted small" style="margin-top:14px">Only people ${esc(ws || "the team")} added can sign in. The link works once and for 15 minutes.</p></div></main>`), status, PUBLIC_HEADERS);
}

function tabNav(p: PortalRow, tab: Tab) {
  return `<nav class="ptabs" aria-label="Sections">${TABS.map(([k, label]) => `<a href="/p/${esc(p.key)}${k === "home" ? "" : `?tab=${k}`}"${k === tab ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
}

type Data = Awaited<ReturnType<typeof clientData>>;
type Item = Data["items"][number];

function fileRow(p: PortalRow, i: Item) {
  return `<li><div class="grow"><div class="t">${esc(i.title)}</div><div class="meta">${i.bytes ? `${sizeText(i.bytes)} · ` : ""}Shared ${dateText(i.addedAt)}</div></div><a class="act" href="/p/${esc(p.key)}/f/${esc(i.id)}" download data-testid="portal-file-download">Download</a></li>`;
}
function filesBody(p: PortalRow, d: Data) {
  const files = d.items.filter((i) => i.kind === "file");
  const reqs = d.items.filter((i) => i.kind === "request");
  const reqHtml = reqs.length ? `<h2 class="sec-h">Asked of you</h2><ul class="list">${reqs.map((r) => `<li><div class="grow"><div class="t">${esc(r.title)}</div><div class="meta">${r.received ? `${r.received} sent so far` : "Nothing sent yet"}</div></div><a class="act primary" href="${esc(r.url ?? "#")}" data-testid="portal-upload">Upload files</a></li>`).join("")}</ul>` : "";
  if (!files.length) return `${reqHtml}<h2 class="sec-h">Shared with you</h2><p class="empty">No files shared yet.</p>`;
  const folders = [...new Set(files.map((f) => f.folder ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return `${reqHtml}${folders.map((f) => `<h2 class="sec-h">${esc(f || "Shared with you")}</h2><ul class="list">${files.filter((x) => (x.folder ?? "") === f).map((x) => fileRow(p, x)).join("")}</ul>`).join("")}`;
}
function docsBody(p: PortalRow, d: Data) {
  const docs = d.items.filter((i) => i.kind === "doc");
  if (!docs.length) return `<p class="empty">No docs shared yet.</p>`;
  return `<ul class="list">${docs.map((x) => `<li><div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">Shared ${dateText(x.addedAt)}</div></div><a class="act" href="/p/${esc(p.key)}/d/${esc(x.id)}">Read</a></li>`).join("")}</ul>`;
}
function tasksBody(d: Data) {
  const tasks = d.items.filter((i) => i.kind === "task");
  if (!tasks.length) return `<p class="empty">No updates shared yet.</p>`;
  return `<ul class="list" data-testid="portal-tasks">${tasks.map((x) => `<li><div class="grow"><div class="t">${esc(x.title)}</div><div class="meta">${x.due ? `Due ${dateText(x.due)}` : "No due date"}</div></div><span class="pill ${esc(x.state ?? "todo")}">${taskStateLabel(x.state)}</span></li>`).join("")}</ul>`;
}
async function messagesBody(c: Context<AppEnv>, p: PortalRow, d: Data, personName: string) {
  const ft = await formToken(c, "portal", p.id);
  const thread = d.messages.length
    ? `<ol class="thread" data-testid="portal-thread">${d.messages.map((m) => `<li class="bubble${m.fromClient ? " me" : ""}"><div class="who">${esc(m.fromClient ? (m.author === personName ? "You" : m.author) : m.author)} · ${when(m.at)}</div>${esc(m.body)}</li>`).join("")}</ol>`
    : `<p class="empty">No messages yet. Ask a question or share an update below.</p>`;
  return `${thread}<form method="post" action="/p/${esc(p.key)}/messages"><input type="hidden" name="ft" value="${ft}"><label for="body">Write a message</label><textarea id="body" name="body" required maxlength="4000" data-testid="portal-message"></textarea><div class="form-row"><button class="act primary" type="submit" data-testid="portal-message-send">Send</button></div></form>`;
}
function homeBody(p: PortalRow, d: Data) {
  const n = (k: string) => d.items.filter((i) => i.kind === k).length;
  const open = d.items.filter((i) => i.kind === "task" && i.state !== "done").length;
  const reqs = d.items.filter((i) => i.kind === "request");
  const last = d.messages[d.messages.length - 1];
  return `${reqs.length ? `<p class="msg"><b>${reqs.length === 1 ? "1 request for files" : `${reqs.length} requests for files`}</b> waiting for you. <a href="/p/${esc(p.key)}?tab=files">See what's asked</a></p>` : ""}
<div class="grid3"><a class="stat" href="/p/${esc(p.key)}?tab=files"><b>${n("file")}</b><span>${n("file") === 1 ? "file" : "files"}</span></a><a class="stat" href="/p/${esc(p.key)}?tab=docs"><b>${n("doc")}</b><span>${n("doc") === 1 ? "doc" : "docs"}</span></a><a class="stat" href="/p/${esc(p.key)}?tab=tasks"><b>${open}</b><span>open ${open === 1 ? "task" : "tasks"}</span></a></div>
<h2 class="sec-h" style="margin-top:22px">Latest message</h2>${last ? `<p><b>${esc(last.author)}</b> <span class="meta">${when(last.at)}</span></p><p style="white-space:pre-wrap">${esc(last.body.slice(0, 280))}${last.body.length > 280 ? "..." : ""}</p><p><a href="/p/${esc(p.key)}?tab=messages">Open messages</a></p>` : `<p class="muted">Nothing yet. <a href="/p/${esc(p.key)}?tab=messages">Send a message</a></p>`}`;
}

async function spacePage(c: Context<AppEnv>, p: PortalRow, person: { name: string | null; email: string }, tab: Tab) {
  const d = await clientData(c.var.deps, p);
  const { head, style } = await brand(c, p, d.workspace);
  const ft = await formToken(c, "portal", p.id);
  const body = tab === "files" ? filesBody(p, d) : tab === "docs" ? docsBody(p, d) : tab === "tasks" ? tasksBody(d) : tab === "messages" ? await messagesBody(c, p, d, person.name || person.email) : homeBody(p, d);
  return publicPage(p.name, `${style}${PAGE_CSS}<header class="top">${head}<form class="out" method="post" action="/p/${esc(p.key)}/out"><input type="hidden" name="ft" value="${ft}"><button class="act" type="submit">Sign out</button></form></header>
<main class="portal wide"><div class="card" data-testid="portal-space"><h1>${esc(p.name)}</h1><p class="lead">Signed in as ${esc(person.email)}</p>${p.welcome && tab === "home" ? `<p class="msg" style="white-space:pre-wrap">${esc(p.welcome)}</p>` : ""}
${tabNav(p, tab)}<section aria-label="${esc(TABS.find((t) => t[0] === tab)![1])}">${body}</section></div>
<p class="muted small center" style="margin-top:16px">A private space from ${esc(d.workspace || "your team")}, made with Multies.</p></main>`);
}

async function formOf(c: Context<AppEnv>): Promise<Record<string, string>> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > 20_000) return {};
  const fd = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  return Object.fromEntries(Object.entries(fd).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

export function portalPublicRoutes() {
  const opens = new RateLimiter(120, 60_000);
  const asks = new RateLimiter(10, 15 * 60_000);
  const posts = new RateLimiter(30, 60_000);
  const load = async (c: Context<AppEnv>) => (on(c) ? portalByKey(c.var.deps, c.req.param("key") ?? "") : null);
  const gone = (c: Context<AppEnv>) => { const m = plain("This space is not available", "Ask the person who shared it with you for a new link.", 404); return c.html(m.html, 404, PUBLIC_HEADERS); };
  const busy = (c: Context<AppEnv>) => { const m = plain("Too many requests", "Try again in a minute."); return c.html(m.html, 429, { ...PUBLIC_HEADERS, "retry-after": "60" }); };
  const session = (c: Context<AppEnv>, p: PortalRow) => clientFromSession(c.var.deps, p, getCookie(c, COOKIE));
  return new Hono<AppEnv>()
    .get("/:key", async (c) => {
      if (!opens.take(c.var.ip)) return busy(c);
      const p = await load(c);
      if (!p) return gone(c);
      const person = await session(c, p);
      if (!person) return signInPage(c, p, c.req.query("sent") ? "If that email can use this space, a sign in link is on its way. Check your inbox." : null);
      const q = c.req.query("tab");
      const tab = (TABS.some((t) => t[0] === q) ? q : "home") as Tab;
      return c.html(await spacePage(c, p, person, tab), 200, PUBLIC_HEADERS);
    })
    .post("/:key/login", async (c) => {
      if (!asks.take(c.var.ip)) return busy(c);
      const p = await load(c);
      if (!p) return gone(c);
      const f = await formOf(c);
      if (!(await publicPostOk(c, "portal", p.id, f.ft))) return signInPage(c, p, null, 403);
      try { await requestClientLink(c.var.deps, p, f.email ?? ""); } catch (e) { if (!(e instanceof HttpError)) throw e; }
      return c.redirect(`/p/${p.key}?sent=1`, 303);
    })
    // The emailed link opens a Continue button: mail scanners that follow links cannot use it up.
    .get("/:key/in/:token", async (c) => {
      if (!opens.take(c.var.ip)) return busy(c);
      const p = await load(c);
      if (!p) return gone(c);
      const ws = await wsName(c, p);
      const { head, style } = await brand(c, p, ws);
      const ft = await formToken(c, "portal", p.id);
      return c.html(publicPage(p.name, `${style}${PAGE_CSS}<header class="top">${head}</header><main><div class="card center"><h1>${esc(p.name)}</h1><p class="muted">Shared with you by ${esc(ws || "your team")}.</p>
<form method="post" action="/p/${esc(p.key)}/in/${esc(c.req.param("token"))}"><input type="hidden" name="ft" value="${ft}"><button class="act primary" type="submit" style="width:100%" data-testid="portal-continue">Continue</button></form></div></main>`), 200, { ...PUBLIC_HEADERS, "referrer-policy": "no-referrer" });
    })
    .post("/:key/in/:token", async (c) => {
      if (!posts.take(c.var.ip)) return busy(c);
      const p = await load(c);
      if (!p) return gone(c);
      const f = await formOf(c);
      if (!(await publicPostOk(c, "portal", p.id, f.ft))) return signInPage(c, p, null, 403);
      const r = await useClientLink(c.var.deps, p, c.req.param("token"));
      if (!r) return signInPage(c, p, "That link has expired or was already used. Ask for a new one below.", 410);
      setCookie(c, COOKIE, r.session, { path: cookiePath(p), httpOnly: true, secure: secure(c), sameSite: "Lax", maxAge: PORTAL_SESSION_DAYS * 86400 });
      return c.redirect(`/p/${p.key}`, 303);
    })
    .get("/:key/f/:item", async (c) => {
      const p = await load(c);
      if (!p) return gone(c);
      if (!(await session(c, p))) return c.redirect(`/p/${p.key}`, 303);
      try {
        const f = await clientFile(c.var.deps, p, c.req.param("item"));
        return c.body(f.bytes as Uint8Array<ArrayBuffer>, 200, { ...PUBLIC_HEADERS, "content-type": f.type, "content-disposition": attachmentDisposition(f.name), "x-content-type-options": "nosniff" });
      } catch (e) { if (e instanceof HttpError && e.status === 404) { const m = plain("This file is no longer shared", "Ask the person who shared it for a new copy.", 404); return c.html(m.html, 404, PUBLIC_HEADERS); } throw e; }
    })
    .get("/:key/d/:item", async (c) => {
      const p = await load(c);
      if (!p) return gone(c);
      const person = await session(c, p);
      if (!person) return c.redirect(`/p/${p.key}`, 303);
      let d: { title: string; content: unknown };
      try { d = await clientDoc(c.var.deps, p, c.req.param("item")); } catch (e) { if (e instanceof HttpError && e.status === 404) { const m = plain("This doc is no longer shared", "Ask the person who shared it for a new link.", 404); return c.html(m.html, 404, PUBLIC_HEADERS); } throw e; }
      const ws = await wsName(c, p);
      const { head, style } = await brand(c, p, ws);
      return c.html(publicPage(d.title, `${style}${PAGE_CSS}<header class="top">${head}</header><main class="portal wide"><p><a href="/p/${esc(p.key)}?tab=docs">Back to docs</a></p><div class="card"><h1>${esc(d.title)}</h1><article class="doc" data-testid="portal-doc">${renderDocHtml(d.content, c.var.deps.config.appUrl)}</article></div></main>`), 200, PUBLIC_HEADERS);
    })
    .post("/:key/messages", async (c) => {
      if (!posts.take(c.var.ip)) return busy(c);
      const p = await load(c);
      if (!p) return gone(c);
      const person = await session(c, p);
      if (!person) return c.redirect(`/p/${p.key}`, 303);
      const f = await formOf(c);
      if (!(await publicPostOk(c, "portal", p.id, f.ft))) return c.redirect(`/p/${p.key}?tab=messages`, 303);
      try { await clientMessage(c.var.deps, p, person, f.body ?? ""); } catch (e) { if (!(e instanceof HttpError)) throw e; }
      return c.redirect(`/p/${p.key}?tab=messages`, 303);
    })
    .post("/:key/out", async (c) => {
      const p = await load(c);
      if (!p) return gone(c);
      const f = await formOf(c);
      if (await publicPostOk(c, "portal", p.id, f.ft)) {
        await endClientSession(c.var.deps, getCookie(c, COOKIE));
        deleteCookie(c, COOKIE, { path: cookiePath(p), secure: secure(c) });
      }
      return c.redirect(`/p/${p.key}`, 303);
    });
}
