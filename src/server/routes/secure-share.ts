/**
 * R88: secure share routes.
 *   File requests (signed in, feature "file_requests"):
 *     GET    /api/tools/requests                  requests (admins: the workspace's; members: their own) and storage use
 *     POST   /api/tools/requests                  make one; the answer carries the link once
 *     GET    /api/tools/requests/:id              one request with its received files
 *     PATCH  /api/tools/requests/:id              { open: boolean } close or reopen
 *     GET    /api/tools/requests/files/:id        download a received file
 *     DELETE /api/tools/requests/files/:id        delete a received file
 *   Secret links (signed in, feature "secrets"):
 *     GET    /api/tools/secrets                   secrets, never their contents
 *     POST   /api/tools/secrets                   { kind, ciphertext (base64url), label?, passphrase, maxViews, expiresInSeconds, notify }
 *     GET    /api/tools/secrets/:id               one secret with its open log
 *     DELETE /api/tools/secrets/:id               turn off (the ciphertext is deleted at once)
 *   Public:
 *     GET  /u/<token>, POST /u/<token>/start, GET|PUT|DELETE /u/<token>/uploads/<id>[/<n>], POST /u/<token>/uploads/<id>/finish
 *     GET  /x/<token>, POST /x/<token>/open
 *     POST /u|x|d/<token>/report               "Report this link"
 * Public POSTs and PUTs need the page's form token (x-ft) and a same origin request, like /d and /sign.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { newId } from "../lib/crypto";
import { sql } from "drizzle-orm";
import { notify } from "../services/suite/notify";
import { agentFamily, countryOf, isPreviewer, keptUsage, regionOf } from "../services/tools/kept-files";
import { PUBLIC_HEADERS, attachmentDisposition, esc, formToken, gateP2, publicOn, publicPage, publicPostOk, sizeText } from "../services/tools/p2-public";
import {
  UploadError, cancelUpload, createRequest, deleteRequestFile, findPublicRequest, finishUpload, listRequests, putChunk, requestDetail, requestFileStream,
  setRequestOpen, startUpload, stateMessage, uploadStatus, type PublicRequestView,
} from "../services/tools/file-requests";
import { createSecret, findPublicSecret, listSecrets, openSecret, revokeSecret, secretDetail, type PublicSecretView } from "../services/tools/secrets";
import { SECRET_PAGE_JS, UPLOAD_PAGE_JS } from "../services/tools/secure-share-scripts";
import { getBrand } from "./branding";
import { logoUrl, pickLogo } from "@/shared/branding";
import { BLOCKED_EXTENSIONS, REPORTS_TO_PAUSE, REPORT_REASONS, REQUEST_CHUNK_BYTES, REQUEST_TYPE_GROUPS, SECRET_KDF_ROUNDS, allowedLabel } from "@/shared/secure-share";

const RequestBody = z.object({
  title: z.string().max(200),
  message: z.string().max(2000).nullable().optional(),
  folder: z.string().max(100).nullable().optional(),
  password: z.string().max(128).nullable().optional(),
  maxFileBytes: z.number().int(),
  maxTotalBytes: z.number().int(),
  allowed: z.string().max(200),
  maxUploads: z.number().int().nullable().optional(),
  keepDays: z.number().int(),
  expiresInDays: z.number().int(),
  showBrand: z.boolean().optional(),
  notify: z.boolean().optional(),
});
const SecretBody = z.object({
  kind: z.enum(["text", "file"]),
  ciphertext: z.string().min(1).max(12_000_000),
  label: z.string().max(200).nullable().optional(),
  passphrase: z.boolean().optional(),
  maxViews: z.number().int(),
  expiresInSeconds: z.number().int(),
  notify: z.boolean().optional(),
});

export function toolsRequestRoutes() {
  const limiter = new RateLimiter(30, 60 * 60_000); // 30 new requests an hour per person, in memory
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await gateP2(c, "file_requests"); await next(); })
    .get("/", async (c) => c.json({ requests: await listRequests(c.var.deps, c.var.auth), usage: await keptUsage(c.var.deps, c.var.auth.orgId) }))
    .post("/", async (c) => {
      const body = await parseBody(c, RequestBody);
      if (!limiter.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many file requests in the last hour.");
      return c.json({ request: await createRequest(c.var.deps, c.var.auth, body, c.var.ip) }, 201);
    })
    .get("/files/:id", async (c) => {
      const f = await requestFileStream(c.var.deps, c.var.auth, c.req.param("id"));
      return new Response(f.stream, { headers: {
        "content-type": "application/octet-stream", "content-disposition": attachmentDisposition(f.name), "content-length": String(f.bytes),
        "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; sandbox",
      } });
    })
    .delete("/files/:id", async (c) => c.json(await deleteRequestFile(c.var.deps, c.var.auth, c.req.param("id"), c.var.ip)))
    .get("/:id", async (c) => c.json(await requestDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/:id", async (c) => c.json(await setRequestOpen(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ open: z.boolean() }))).open, c.var.ip)));
}

export function toolsSecretRoutes() {
  const limiter = new RateLimiter(60, 60 * 60_000); // 60 new secrets an hour per person, in memory
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await gateP2(c, "secrets"); await next(); })
    .get("/", async (c) => c.json({ secrets: await listSecrets(c.var.deps, c.var.auth) }))
    .post("/", async (c) => {
      const body = await parseBody(c, SecretBody);
      if (!limiter.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many secret links in the last hour.");
      return c.json({ secret: await createSecret(c.var.deps, c.var.auth, body, c.var.ip) }, 201);
    })
    .get("/:id", async (c) => c.json(await secretDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .delete("/:id", async (c) => c.json(await revokeSecret(c.var.deps, c.var.auth, c.req.param("id"), c.var.ip)));
}

// ---------------------------------------------------------------------------
// Public pages
// ---------------------------------------------------------------------------
const jsErr = (c: Context<AppEnv>, status: number, code: string, message: string) =>
  c.json({ error: { code, message } }, status as 400, { ...PUBLIC_HEADERS });

function message(title: string, body: string, status = 200) {
  return { html: publicPage(title, `<header class="top"><span class="brand">Multies</span></header><main><div class="card"><h1>${esc(title)}</h1><p class="muted">${esc(body)}</p></div></main>`), status };
}

/** "Report this link": a closed details box with a reason and a note; a form POST, so it works without the page's script. */
export function reportBox(ft: string, action: string) {
  return `<details class="report"><summary>Report this link</summary><form method="post" action="${esc(action)}"><input type="hidden" name="ft" value="${ft}">
<label for="rr">What is wrong?</label><select id="rr" name="reason">${REPORT_REASONS.map((r) => `<option value="${r.value}">${esc(r.label)}</option>`).join("")}</select>
<label for="rd">Anything else <span class="muted">(optional)</span></label><textarea id="rd" name="detail" maxlength="500"></textarea>
<div class="row"><button type="submit" class="sec">Send report</button></div></form></details>`;
}

/** One report: a row, a count on the link (3 pause it), and a note to the link's owner. 5 reports an hour per address. */
export async function takeReport(c: Context<AppEnv>, kind: "share" | "request" | "secret", target: { id: string; org_id: string; created_by: string; token_hash: string }, limiter: RateLimiter): Promise<boolean> {
  if (!limiter.take(c.var.ip)) return false;
  const fd = await c.req.formData().catch(() => null);
  const ft = fd?.get("ft");
  if (!(await publicPostOk(c, kind === "share" ? "share" : kind, target.token_hash, typeof ft === "string" ? ft : null))) return false;
  const reason = String(fd?.get("reason") ?? "other");
  const r = REPORT_REASONS.some((x) => x.value === reason) ? reason : "other";
  const detail = String(fd?.get("detail") ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, 500) || null;
  const { deps } = c.var;
  const now = deps.now().getTime();
  await deps.db.run(sql`insert into tool_link_reports (id, kind, target_id, org_id, reason, detail, country, at) values (${newId("lrp")}, ${kind}, ${target.id}, ${target.org_id}, ${r}, ${detail}, ${countryOf(c.req.raw.headers)}, ${now})`);
  const table = kind === "share" ? sql`tool_shares` : kind === "request" ? sql`tool_file_requests` : sql`tool_secrets`;
  await deps.db.run(sql`update ${table} set reports = reports + 1 where id = ${target.id}`);
  await notify(deps, target.org_id, target.created_by, { type: "tools.link_reported", entityType: kind === "secret" ? "secret" : kind === "request" ? "file_request" : "share", entityId: target.id, title: `Someone reported one of your ${kind === "secret" ? "secret links" : kind === "request" ? "file requests" : "share links"}. ${REPORTS_TO_PAUSE} reports pause a link.` });
  return true;
}

async function brandBlock(c: Context<AppEnv>, v: PublicRequestView): Promise<{ head: string; style: string }> {
  const ws = esc(v.workspace);
  if (!v.row.show_brand) return { head: `<header class="top"><span class="brand">Multies</span></header>`, style: "" };
  const b = await getBrand(c.var.deps.db, v.row.org_id).catch(() => null);
  const kind = b ? pickLogo(b, "wide", "light") ?? pickLogo(b, "mark", "light") : null;
  const logo = b && kind ? `<img class="logo" src="${esc(logoUrl(v.row.org_id, kind, b.logos[kind]!))}" alt="${ws}">` : "";
  const colour = b?.primary && /^#[0-9a-fA-F]{6}$/.test(b.primary) ? b.primary : null;
  return {
    head: `<header class="top">${logo || `<span class="brand ws-name">${ws || "Multies"}</span>`}${logo && ws ? `<span class="ws">${ws}</span>` : ""}</header>`,
    style: colour ? `<style>:root{--brand:${colour}}</style>` : "",
  };
}

const PAGE_CSS = `<style>
.center{text-align:center}.link{background:none;border:0;color:var(--brand);padding:4px 6px;min-height:32px;font-weight:500}
.logo{max-height:32px;max-width:180px;display:block}.drop{border:1.5px dashed var(--line);border-radius:14px;padding:26px 16px;text-align:center;margin:16px 0;outline:none}
.drop.over,.drop:focus-visible{border-color:var(--brand);background:color-mix(in srgb,var(--brand) 6%,transparent)}
.uploads{list-style:none;padding:0;margin:8px 0}.up{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:8px 0}
.up-top{display:flex;gap:10px;align-items:center}.up-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.bar{height:6px;border-radius:99px;background:color-mix(in srgb,var(--line) 60%,transparent);overflow:hidden;margin:8px 0 2px}.bar span{display:block;height:100%;width:0;background:var(--brand);transition:width .2s}
.bar.ok span{background:var(--good)}.bar.bad span{background:var(--bad)}.limits{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 0;padding:0;list-style:none}
.limits li{font-size:12.5px;border:1px solid var(--line);border-radius:99px;padding:3px 10px;color:var(--muted)}.msg{white-space:pre-wrap;margin:10px 0 0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}@media (max-width:520px){.grid2{grid-template-columns:1fr}}
.report{margin-top:18px;font-size:13px;color:var(--muted)}.report summary{cursor:pointer;text-align:center;list-style:none}.report summary::-webkit-details-marker{display:none}
.report form{text-align:left;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin-top:8px}
pre.secret{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;max-height:50vh;overflow:auto;margin:12px 0}
.warn{display:flex;gap:12px;align-items:flex-start;background:color-mix(in srgb,#ff9f0a 12%,transparent);border-radius:12px;padding:12px 14px;margin:12px 0}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px}@media (prefers-reduced-motion:reduce){.bar span{transition:none}}
</style>`;

function dateText(ms: number) {
  return new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

async function uploadPage(c: Context<AppEnv>, v: PublicRequestView) {
  const r = v.row;
  const ft = await formToken(c, "request", r.token_hash);
  const { head, style } = await brandBlock(c, v);
  const exts = r.allowed === "any" ? null : r.allowed.split(",").flatMap((g) => [...((REQUEST_TYPE_GROUPS as Record<string, { ext: readonly string[] }>)[g]?.ext ?? [])]);
  const room = Math.max(0, r.max_total_bytes - r.bytes_received);
  const accept = exts ? ` accept="${exts.map((e) => `.${e}`).join(",")}"` : "";
  const limits = [
    `Files up to ${sizeText(r.max_file_bytes)}`, allowedLabel(r.allowed), `${sizeText(room)} of room left`,
    r.max_uploads !== null ? `${Math.max(0, r.max_uploads - r.uploads)} files left` : "", `Open until ${dateText(r.expires_at)}`,
  ].filter(Boolean);
  return publicPage(`Send files: ${r.title}`, `${style}${PAGE_CSS}${head}
<main class="wide"><div class="card" id="req-app" data-ft="${ft}" data-chunk="${REQUEST_CHUNK_BYTES}" data-maxfile="${r.max_file_bytes}" data-allowed='${esc(JSON.stringify(exts))}' data-blocked='${esc(JSON.stringify(BLOCKED_EXTENSIONS))}'>
<div id="form">
<h1>${esc(r.title)}</h1>
${v.workspace ? `<p class="muted small">${esc(v.workspace)} asked you for files. You don't need an account.</p>` : ""}
${r.message ? `<p class="msg">${esc(r.message)}</p>` : ""}
<ul class="limits" aria-label="Limits">${limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<div class="grid2"><div><label for="who">Your name <span class="muted">(optional)</span></label><input id="who" type="text" maxlength="120" autocomplete="name"></div>
<div><label for="email">Your email <span class="muted">(optional)</span></label><input id="email" type="email" maxlength="200" autocomplete="email"></div></div>
<label for="note">A note <span class="muted">(optional)</span></label><textarea id="note" maxlength="1000"></textarea>
${r.password_hash ? `<label for="pw">Password</label><input id="pw" type="password" maxlength="128" autocomplete="off" required>` : ""}
<div class="drop" id="drop" tabindex="0" role="button" aria-label="Choose files to send"><p style="margin:0 0 10px">Drop files here</p><button type="button" class="sec" id="pick">Choose files</button><input id="file" type="file" multiple hidden${accept}></div>
<ul class="uploads" id="list" aria-label="Files to send"></ul>
<p id="status" role="status" aria-live="polite" class="muted"></p>
<div class="row"><button type="button" id="send" class="full" disabled>Send files</button></div>
<p class="muted small">Big files go up in parts. If the connection drops, open this link again and add the same file to carry on.</p>
</div>
<div id="done" hidden tabindex="-1" class="center"><h1>Thank you</h1><p id="done-n" class="muted"></p><div class="row" style="justify-content:center"><button type="button" class="sec" id="again">Send more files</button></div></div>
</div>
<p class="muted small center" style="margin-top:16px">Sent securely with Multies. Files go only to ${esc(v.workspace || "the person who sent this link")}.</p>
${reportBox(ft, `/u/${c.req.param("token")}/report`)}</main>`, { script: "/u/_/upload.js" });
}

function readBlob(c: Context<AppEnv>, max: number): Promise<Uint8Array> {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > max + 1024) throw new UploadError(413, "too_large", "That part is too big.");
  return c.req.arrayBuffer().then((b) => new Uint8Array(b));
}

export function requestPublicRoutes() {
  const opens = new RateLimiter(60, 60_000);
  const starts = new RateLimiter(30, 60_000);
  const chunks = new RateLimiter(400, 60_000);
  const reports = new RateLimiter(5, 60 * 60_000);
  const view = async (c: Context<AppEnv>) => (publicOn(c, "file_requests") ? findPublicRequest(c.var.deps, c.req.param("token") ?? "") : null);
  // Every JSON call from the page: the feature, the link, a same origin request with the page's form token.
  const guard = async (c: Context<AppEnv>, limiter: RateLimiter): Promise<PublicRequestView | Response> => {
    if (!limiter.take(c.var.ip)) return jsErr(c, 429, "rate_limited", "Too many tries. Wait a minute and try again.");
    const v = await view(c);
    if (!v) return jsErr(c, 404, "gone", "This link is no longer active.");
    if (!(await publicPostOk(c, "request", v.row.token_hash, c.req.header("x-ft")))) return jsErr(c, 403, "blocked", "Open the link again and try once more.");
    return v;
  };
  const run = async (c: Context<AppEnv>, fn: () => Promise<unknown>) => {
    try { return c.json(await fn(), 200, { ...PUBLIC_HEADERS }); } catch (e) {
      if (e instanceof HttpError) return jsErr(c, e.status, e.code, e.message);
      throw e;
    }
  };
  return new Hono<AppEnv>()
    .get("/_/upload.js", (c) => c.body(UPLOAD_PAGE_JS, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }))
    .get("/:token", async (c) => {
      if (!opens.take(c.var.ip)) { const m = message("Too many requests", "Try again in a minute."); return c.html(m.html, 429, { ...PUBLIC_HEADERS, "retry-after": "60" }); }
      const v = await view(c);
      if (!v) { const m = message("This link is no longer active", "Ask the person who sent it for a new one."); return c.html(m.html, 404, PUBLIC_HEADERS); }
      if (v.state !== "open") { const m = message(v.state === "full" ? "This request is full" : v.state === "paused" ? "This request is paused" : "This request is closed", stateMessage(v.state)); return c.html(m.html, v.state === "locked" ? 429 : 410, PUBLIC_HEADERS); }
      return c.html(await uploadPage(c, v), 200, PUBLIC_HEADERS);
    })
    .post("/:token/report", async (c) => {
      const v = await view(c);
      if (!v) { const m = message("This link is no longer active", "Thanks for letting us know."); return c.html(m.html, 404, PUBLIC_HEADERS); }
      const ok = await takeReport(c, "request", v.row, reports);
      const m = message(ok ? "Thanks for the report" : "Report not sent", ok ? "We will look at this link. You can close this page." : "Open the link again and try once more.");
      return c.html(m.html, ok ? 200 : 429, PUBLIC_HEADERS);
    })
    .post("/:token/start", async (c) => {
      const v = await guard(c, starts);
      if (v instanceof Response) return v;
      const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
      if (!b || typeof b.name !== "string") return jsErr(c, 400, "bad_request", "Choose a file.");
      const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : null);
      return run(c, () => startUpload(c.var.deps, v, { name: b.name as string, size: Number(b.size), type: s("type"), password: s("password"), uploaderName: s("uploaderName"), uploaderEmail: s("uploaderEmail"), note: s("note") }, { country: countryOf(c.req.raw.headers) }));
    })
    .get("/:token/uploads/:id", async (c) => {
      const v = await guard(c, chunks);
      if (v instanceof Response) return v;
      return run(c, () => uploadStatus(c.var.deps, v, c.req.param("id"), c.req.header("x-upload-key") ?? null));
    })
    .put("/:token/uploads/:id/:n", async (c) => {
      const v = await guard(c, chunks);
      if (v instanceof Response) return v;
      return run(c, async () => putChunk(c.var.deps, v, c.req.param("id"), c.req.header("x-upload-key") ?? null, Number(c.req.param("n")), await readBlob(c, REQUEST_CHUNK_BYTES)));
    })
    .post("/:token/uploads/:id/finish", async (c) => {
      const v = await guard(c, chunks);
      if (v instanceof Response) return v;
      return run(c, () => finishUpload(c.var.deps, v, c.req.param("id"), c.req.header("x-upload-key") ?? null));
    })
    .delete("/:token/uploads/:id", async (c) => {
      const v = await guard(c, chunks);
      if (v instanceof Response) return v;
      return run(c, async () => { await cancelUpload(c.var.deps, v, c.req.param("id"), c.req.header("x-upload-key") ?? null); return { ok: true }; });
    });
}

async function secretPage(c: Context<AppEnv>, v: PublicSecretView) {
  const r = v.row;
  const ft = await formToken(c, "secret", r.token_hash);
  const left = r.max_views - r.views;
  return publicPage("Someone sent you a secret", `${PAGE_CSS}<header class="top"><span class="brand">Multies</span></header>
<main><div class="card" id="sec-app" data-ft="${ft}" data-rounds="${SECRET_KDF_ROUNDS}">
<div id="s-warn">
<h1>Someone sent you a secret</h1>
<p class="muted">${v.workspace ? `From someone at ${esc(v.workspace)}. ` : ""}It is ${r.kind === "file" ? "a file" : "a message"}${r.passphrase ? " locked with a passphrase" : ""}.</p>
<div class="warn" role="note"><span aria-hidden="true">!</span><span>${left <= 1 ? "It can be opened once. When you open it, it is deleted for good, so have somewhere ready to keep it." : `It can be opened ${left} more times. After that it is deleted for good.`}</span></div>
<div class="row"><button type="button" id="reveal" class="full">Show secret</button></div>
<p class="muted small">Only open secrets from people you know. Multies can't read this secret: it is unlocked in your browser.</p>
</div>
<div id="s-pass" hidden><h1>Enter the passphrase</h1><p class="muted">The sender should have told you this another way.</p>
<form id="s-passform" autocomplete="off"><label for="s-pw">Passphrase</label><input id="s-pw" type="password" maxlength="200"><div class="row"><button type="submit" id="s-unlock" class="full">Unlock</button></div></form></div>
<div id="s-out" hidden><h1>Your secret</h1>
<div id="s-textbox" hidden><pre class="secret" id="s-text" tabindex="0" aria-label="Secret"></pre><div class="row"><button type="button" id="s-copy">Copy</button></div></div>
<div id="s-filebox" hidden><div class="file"><div class="ico" aria-hidden="true">FILE</div><div><p id="s-fname" style="font-weight:600;word-break:break-word"></p></div></div><a class="btn" id="s-file" href="#">Download</a></div>
<p class="muted small" id="s-left"></p></div>
<p id="s-status" role="status" aria-live="polite" class="muted"></p>
</div>
${reportBox(ft, `/x/${c.req.param("token")}/report`)}</main>`, { script: "/x/_/secret.js" });
}

export function secretPublicRoutes() {
  const opensPage = new RateLimiter(60, 60_000);
  const opens = new RateLimiter(20, 60_000);
  const reports = new RateLimiter(5, 60 * 60_000);
  const view = async (c: Context<AppEnv>) => (publicOn(c, "secrets") ? findPublicSecret(c.var.deps, c.req.param("token") ?? "") : null);
  const goneMsg = (v: PublicSecretView | null) => v?.state === "paused" ? message("This secret is paused", "It is being checked after a report.")
    : v?.state === "burned" || v?.state === "opened" ? message("This secret is gone", "It was already opened, so it has been deleted. Ask the sender to send it again if you need it.")
      : message("This secret is no longer available", "It expired or the sender turned it off. Ask them to send a new one.");
  return new Hono<AppEnv>()
    .get("/_/secret.js", (c) => c.body(SECRET_PAGE_JS, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=300" }))
    .get("/:token", async (c) => {
      if (!opensPage.take(c.var.ip)) { const m = message("Too many requests", "Try again in a minute."); return c.html(m.html, 429, { ...PUBLIC_HEADERS, "retry-after": "60" }); }
      const v = await view(c);
      if (!v || (v.state !== "waiting" && v.state !== "opened")) { const m = goneMsg(v); return c.html(m.html, v ? 410 : 404, PUBLIC_HEADERS); }
      return c.html(await secretPage(c, v), 200, PUBLIC_HEADERS);
    })
    .post("/:token/open", async (c) => {
      if (!opens.take(c.var.ip)) return jsErr(c, 429, "rate_limited", "Too many tries. Wait a minute and try again.");
      const v = await view(c);
      if (!v) return jsErr(c, 404, "gone", "This secret is no longer available.");
      if (!(await publicPostOk(c, "secret", v.row.token_hash, c.req.header("x-ft")))) return jsErr(c, 403, "blocked", "Open the link again and try once more.");
      const r = await openSecret(c.var.deps, v, { country: countryOf(c.req.raw.headers), region: regionOf(c.req.raw), agent: agentFamily(c.req.header("user-agent")) });
      if (!r.ok) return jsErr(c, 410, r.reason, r.reason === "paused" ? "This secret is paused while it is checked." : "This secret was already opened or has expired, so it is gone.");
      return c.json({ kind: r.kind, ciphertext: r.ciphertext, passphrase: r.passphrase, viewsLeft: r.viewsLeft }, 200, { ...PUBLIC_HEADERS });
    })
    .post("/:token/report", async (c) => {
      const v = await view(c);
      if (!v) { const m = message("This secret is no longer available", "Thanks for letting us know."); return c.html(m.html, 404, PUBLIC_HEADERS); }
      const ok = await takeReport(c, "secret", v.row, reports);
      const m = message(ok ? "Thanks for the report" : "Report not sent", ok ? "We will look at this link. You can close this page." : "Open the link again and try once more.");
      return c.html(m.html, ok ? 200 : 429, PUBLIC_HEADERS);
    });
}

/** Share links (/d): log a page open as a view, unless a link previewer or a script fetched it. */
export async function logShareView(c: Context<AppEnv>, share: { id: string; org_id: string }): Promise<void> {
  const ua = c.req.header("user-agent");
  if (isPreviewer(ua)) return;
  const { deps } = c.var;
  const now = deps.now().getTime();
  await deps.db.run(sql`update tool_shares set views = views + 1 where id = ${share.id}`);
  await deps.db.run(sql`insert into tool_share_downloads (id, share_id, org_id, at, country, agent, kind, region) values (${newId("shd")}, ${share.id}, ${share.org_id}, ${now}, ${countryOf(c.req.raw.headers)}, ${agentFamily(ua)}, 'view', ${regionOf(c.req.raw)})`);
}
