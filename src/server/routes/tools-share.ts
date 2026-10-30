/**
 * Tools P2 (H5): secure share links.
 *   GET    /api/tools/share            links (admins: the workspace's; others: their own) and live storage use
 *   GET    /api/tools/share/:id        one link with its download log
 *   POST   /api/tools/share            multipart upload (file, expires, password, maxDownloads, notifyFirst); upload header required
 *   POST   /api/tools/share/from       { source: "result", token } | { source: "attachment", attachmentId }, same options
 *   DELETE /api/tools/share/:id        revoke (the file is deleted at once)
 *   GET    /d/<token>                  the public page (file name, size, workspace name, password box, download)
 *   POST   /d/<token>                  the download (same origin, form token, password checked, limit taken, logged)
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { createShare, findPublicShare, listShares, revokeShare, shareDetail, takeDownload, type NewShare, type PublicShareView } from "../services/tools/share";
import { agentFamily, countryOf, keptUsage } from "../services/tools/kept-files";
import { fileOfForm, fromAttachment, fromToolResult, readUploadForm, type SourceFile } from "../services/tools/p2-sources";
import { PUBLIC_HEADERS, attachmentDisposition, esc, formToken, gateP2, publicOn, publicPage, publicPostOk, sizeText } from "../services/tools/p2-public";
import { TOOLS_UPLOAD_HEADER } from "./tools";

const Opts = z.object({
  expiresInSeconds: z.coerce.number().int(),
  password: z.string().max(128).optional().nullable(),
  maxDownloads: z.union([z.literal(""), z.null(), z.coerce.number().int()]).optional(),
  notifyFirst: z.union([z.boolean(), z.enum(["true", "false", "1", "0", "on"])]).optional(),
});
const FromBody = Opts.extend({ source: z.enum(["result", "attachment"]), token: z.string().max(1200).optional(), attachmentId: z.string().max(64).optional() });

function optsOf(o: z.infer<typeof Opts>): Omit<NewShare, "bytes" | "name" | "contentType" | "source"> {
  const max = o.maxDownloads === "" || o.maxDownloads === null || o.maxDownloads === undefined ? null : Number(o.maxDownloads);
  const nf = o.notifyFirst === true || o.notifyFirst === "true" || o.notifyFirst === "1" || o.notifyFirst === "on";
  return { expiresInSeconds: o.expiresInSeconds, password: o.password ?? null, maxDownloads: max, notifyFirst: nf };
}

function bad(msg: string): never { throw new HttpError(400, "bad_request", msg); }

export function toolsShareRoutes() {
  const limiter = new RateLimiter(60, 60 * 60_000); // 60 new links an hour per person, in memory
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await gateP2(c, "share"); await next(); })
    .get("/", async (c) => c.json({ links: await listShares(c.var.deps, c.var.auth), usage: await keptUsage(c.var.deps, c.var.auth.orgId) }))
    .get("/:id", async (c) => c.json(await shareDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/", async (c) => {
      if (c.req.header(TOOLS_UPLOAD_HEADER) !== "1") throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
      if (!limiter.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many share links in the last hour.");
      const fd = await readUploadForm(c.req.raw);
      const file = await fileOfForm(fd);
      const o = Opts.safeParse({ expiresInSeconds: fd.get("expiresInSeconds"), password: fd.get("password") || null, maxDownloads: fd.get("maxDownloads") ?? null, notifyFirst: fd.get("notifyFirst") ?? undefined });
      if (!o.success) bad("Choose when the link expires.");
      return c.json({ link: await createShare(c.var.deps, c.var.auth, { ...file, source: "upload", ...optsOf(o.data) }, c.var.ip) }, 201);
    })
    .post("/from", async (c) => {
      const b = FromBody.safeParse(await c.req.json().catch(() => null));
      if (!b.success) bad("Choose a file and when the link expires.");
      if (!limiter.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many share links in the last hour.");
      let file: SourceFile;
      if (b.data.source === "result") file = await fromToolResult(c.var.deps, c.var.auth, b.data.token ?? bad("Choose a result."));
      else file = await fromAttachment(c.var.deps, c.var.auth, b.data.attachmentId ?? bad("Choose an attachment."));
      return c.json({ link: await createShare(c.var.deps, c.var.auth, { bytes: file.bytes, name: file.name, contentType: file.contentType, source: b.data.source, ...optsOf(b.data) }, c.var.ip) }, 201);
    })
    .delete("/:id", async (c) => c.json(await revokeShare(c.var.deps, c.var.auth, c.req.param("id"), c.var.ip)));
}

const GONE: Record<string, [string, string]> = {
  gone: ["This link is no longer active", "Ask the person who sent it for a new one."],
  used_up: ["This link has been used up", "It reached its download limit. Ask the person who sent it for a new one."],
  missing: ["This file is no longer available", "Ask the person who sent it for a new one."],
  locked: ["Too many wrong passwords", "This link is paused for 15 minutes. Try again later."],
};

function gonePage(kind: keyof typeof GONE) {
  const [h, p] = GONE[kind];
  return publicPage(h, `<header class="top"><span class="brand">Multies</span></header><main><div class="card"><h1>${h}</h1><p class="muted">${p}</p></div></main>`);
}

function extOf(name: string) { const m = name.match(/\.([A-Za-z0-9]{1,5})$/); return m ? m[1].toUpperCase() : "FILE"; }

async function sharePage(c: Context<AppEnv>, v: PublicShareView, error?: string) {
  const r = v.row;
  const ft = await formToken(c, "share", r.token_hash);
  const expires = new Date(r.expires_at).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const left = r.max_downloads !== null ? `<p class="muted small">${r.max_downloads - r.downloads} of ${r.max_downloads} downloads left.</p>` : "";
  return publicPage(r.name, `<header class="top"><span class="brand">Multies</span></header>
<main><div class="card">
<div class="file"><div class="ico" aria-hidden="true">${esc(extOf(r.name))}</div><div><h1>${esc(r.name)}</h1><p class="muted small">${esc(sizeText(r.bytes))}${v.workspace ? ` · Shared by ${esc(v.workspace)}` : ""}</p></div></div>
<form method="post" action="" autocomplete="off">
<input type="hidden" name="ft" value="${ft}">
${r.password_hash ? `<label for="pw">Password</label><input id="pw" name="password" type="password" required maxlength="128" autofocus>` : ""}
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<div class="row"><button type="submit" class="full">Download</button></div>
</form>
${left}<p class="muted small">This link expires on ${esc(expires)} UTC.</p>
</div><p class="muted small" style="text-align:center;margin-top:16px">Shared securely with Multies. Only open files from people you trust.</p></main>`);
}

/** The public share page and its download. 60 page opens and 20 downloads a minute per address, in memory. */
export function sharePublicRoutes() {
  const opens = new RateLimiter(60, 60_000);
  const posts = new RateLimiter(20, 60_000);
  return new Hono<AppEnv>()
    .get("/:token", async (c) => {
      if (!publicOn(c, "share")) return c.html(gonePage("gone"), 404, PUBLIC_HEADERS);
      if (!opens.take(c.var.ip)) return c.html(publicPage("Too many requests", `<main><div class="card"><h1>Too many requests</h1><p class="muted">Try again in a minute.</p></div></main>`), 429, { ...PUBLIC_HEADERS, "retry-after": "60" });
      const v = await findPublicShare(c.var.deps, c.req.param("token"));
      if (!v) return c.html(gonePage("gone"), 404, PUBLIC_HEADERS);
      if (v.state !== "active") return c.html(gonePage(v.state === "locked" ? "locked" : v.state === "used_up" ? "used_up" : "gone"), v.state === "locked" ? 429 : 410, PUBLIC_HEADERS);
      return c.html(await sharePage(c, v), 200, PUBLIC_HEADERS);
    })
    .post("/:token", async (c) => {
      if (!publicOn(c, "share")) return c.html(gonePage("gone"), 404, PUBLIC_HEADERS);
      if (!posts.take(c.var.ip)) return c.html(gonePage("locked"), 429, { ...PUBLIC_HEADERS, "retry-after": "60" });
      const v = await findPublicShare(c.var.deps, c.req.param("token"));
      if (!v) return c.html(gonePage("gone"), 404, PUBLIC_HEADERS);
      const fd = await c.req.formData().catch(() => null);
      const ft = fd?.get("ft");
      if (!(await publicPostOk(c, "share", v.row.token_hash, typeof ft === "string" ? ft : null))) {
        return c.html(publicPage("Request blocked", `<main><div class="card"><h1>Request blocked</h1><p class="muted">Open the link again and use the Download button.</p></div></main>`), 403, PUBLIC_HEADERS);
      }
      const pw = fd?.get("password");
      const r = await takeDownload(c.var.deps, v, typeof pw === "string" ? pw : null, { country: countryOf(c.req.raw.headers), agent: agentFamily(c.req.header("user-agent")) });
      if (!r.ok) {
        if (r.reason === "password") return c.html(await sharePage(c, v, `That password is not right. ${r.triesLeft} ${r.triesLeft === 1 ? "try" : "tries"} left.`), 401, PUBLIC_HEADERS);
        return c.html(gonePage(r.reason), r.reason === "locked" ? 429 : 410, PUBLIC_HEADERS);
      }
      return new Response(r.bytes as BodyInit, { status: 200, headers: {
        ...PUBLIC_HEADERS, "content-type": "application/octet-stream", "content-disposition": attachmentDisposition(r.name),
        "content-length": String(r.bytes.byteLength), "x-content-type-options": "nosniff",
      } });
    });
}
