/**
 * Tools P2 (H5): e-sign.
 *   GET    /api/tools/esign                  requests (not drafts) with signer status, and live storage use
 *   POST   /api/tools/esign/documents        multipart upload of a PDF (upload header required) -> a draft
 *   POST   /api/tools/esign/documents/from   { source: "result", token } | { source: "attachment", attachmentId } -> a draft
 *   GET    /api/tools/esign/:id/pages        { status: working } until the engine has the page previews, then sizes and pictures
 *   POST   /api/tools/esign/:id/self         { fields, images } sign it yourself
 *   POST   /api/tools/esign/:id/send         { signers, order, fields, message, subject?, mailboxId?, inReplyToId?, expiresDays, remindDays }
 *   GET    /api/tools/esign/:id              one request with its signing record (moves a finishing one on)
 *   POST   /api/tools/esign/:id/cancel       cancel (links stop working, files deleted)
 *   GET    /api/tools/esign/:id/download     the signed copy
 *   GET    /sign/<token>                     the signer's page (no account needed)
 *   GET    /sign/<token>/document            the document to read (inline PDF)
 *   GET    /sign/<token>/page/<n>            a page picture with this signer's fields
 *   POST   /sign/<token>                     { ft, action: "sign", images } | { ft, action: "decline", reason }
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { imageType, advance, cancelRequest, declineAsSigner, draftPages, fieldsFor, findSigner, listRequests, markViewed, pageImages, requestDetail, requestFile, requestRow, sendRequest, signAsSigner, signSelf, startDraft, type SignerView } from "../services/tools/esign";
import { countryOf, keptUsage, readKeptFile } from "../services/tools/kept-files";
import { fileOfForm, fromAttachment, fromToolResult, readUploadForm } from "../services/tools/p2-sources";
import { PUBLIC_HEADERS, attachmentDisposition, esc, formToken, gateP2, publicOn, publicPage, publicPostOk } from "../services/tools/p2-public";
import { SIGN_PAGE_JS } from "../services/tools/sign-page-script";
import { TOOLS_UPLOAD_HEADER } from "./tools";
import { ESIGN_NOTE, SIGN_MAX_SIGNERS, type SignField } from "@/shared/share-sign";

const Field = z.object({ signer: z.number().int().min(0).max(SIGN_MAX_SIGNERS - 1).default(0), kind: z.enum(["signature", "initials", "date"]), page: z.number().int().min(1).max(500), x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive() });
const SelfBody = z.object({ fields: z.array(Field).min(1).max(60), images: z.array(z.string().max(450_000)).min(1).max(60) });
const SendBody = z.object({
  signers: z.array(z.object({ name: z.string().min(1).max(120), email: z.string().min(3).max(254) })).min(1).max(SIGN_MAX_SIGNERS),
  order: z.enum(["any", "sequence"]).default("any"),
  fields: z.array(Field).min(1).max(60),
  message: z.string().max(2000).optional(),
  subject: z.string().max(200).optional(),
  mailboxId: z.string().max(64).optional(),
  inReplyToId: z.string().max(64).nullable().optional(),
  expiresDays: z.number().int().min(1).max(30).default(14),
  remindDays: z.number().int().min(0).max(14).default(3),
});
const FromBody = z.object({ source: z.enum(["result", "attachment"]), token: z.string().max(1200).optional(), attachmentId: z.string().max(64).optional() });

function bad(msg: string): never { throw new HttpError(400, "bad_request", msg); }
async function json<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const r = schema.safeParse(await c.req.json().catch(() => null));
  if (!r.success) bad(r.error.issues[0]?.message ?? "Check the details and try again.");
  return r.data;
}

export function toolsEsignRoutes() {
  const starts = new RateLimiter(60, 60 * 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await gateP2(c, "esign"); await next(); })
    .get("/", async (c) => c.json({ requests: await listRequests(c.var.deps, c.var.auth), usage: await keptUsage(c.var.deps, c.var.auth.orgId), note: ESIGN_NOTE }))
    .post("/documents", async (c) => {
      if (c.req.header(TOOLS_UPLOAD_HEADER) !== "1") throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
      if (!starts.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many documents in the last hour.");
      const file = await fileOfForm(await readUploadForm(c.req.raw));
      return c.json(await startDraft(c.var.deps, c.var.auth, file, c.var.ip), 201);
    })
    .post("/documents/from", async (c) => {
      const b = await json(c, FromBody);
      if (!starts.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many documents in the last hour.");
      const file = b.source === "result" ? await fromToolResult(c.var.deps, c.var.auth, b.token ?? bad("Choose a result.")) : await fromAttachment(c.var.deps, c.var.auth, b.attachmentId ?? bad("Choose an attachment."));
      return c.json(await startDraft(c.var.deps, c.var.auth, file, c.var.ip), 201);
    })
    .get("/:id/pages", async (c) => c.json(await draftPages(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/self", async (c) => {
      const b = await json(c, SelfBody);
      return c.json(await signSelf(c.var.deps, c.var.auth, c.req.param("id"), { fields: b.fields as SignField[], images: b.images }, c.var.ip));
    })
    .post("/:id/send", async (c) => {
      const b = await json(c, SendBody);
      return c.json(await sendRequest(c.var.deps, c.var.auth, c.req.param("id"), { ...b, fields: b.fields as SignField[] }, c.var.ip));
    })
    .get("/:id", async (c) => c.json(await requestDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/cancel", async (c) => c.json(await cancelRequest(c.var.deps, c.var.auth, c.req.param("id"), c.var.ip)))
    .get("/:id/download", async (c) => {
      const f = await requestFile(c.var.deps, c.var.auth, c.req.param("id"));
      return new Response(f.bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": attachmentDisposition(f.name), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    });
}

// ---------------------------------------------------------------------------
// The signer's page
// ---------------------------------------------------------------------------
const FONTS = ["Dancing Script", "Great Vibes", "Caveat"];
const FONT_FILES: Record<string, string> = { "Dancing Script": "DancingScript", "Great Vibes": "GreatVibes-Regular", Caveat: "Caveat" };
const fontCss = FONTS.map((f) => `@font-face{font-family:'${f}';src:url(/fonts/sign/${FONT_FILES[f]}.woff2) format('woff2');font-display:swap}`).join("");

function shell(title: string, inner: string, script = false) {
  return publicPage(title, `<style>${fontCss}</style><header class="top"><span class="brand">Multies</span></header><main class="wide">${inner}</main>`, script ? { script: "/sign/_/sign.js" } : {});
}

function message(title: string, text: string) {
  return shell(title, `<div class="card"><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><p class="note">${esc(ESIGN_NOTE)}</p></div>`);
}

const dateText = (ms: number | null) => (ms ? new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "");

async function signerPage(c: Context<AppEnv>, v: SignerView, token: string) {
  const { r, s } = v;
  if (v.state === "signed") return message("You have signed", `You signed ${r.title} on ${dateText(s.signed_at)}. ${r.status === "completed" ? "Everyone has signed; the signed copy was emailed to you." : "When everyone has signed, the signed copy is emailed to you."}`);
  if (v.state === "declined") return message("You declined to sign", `You declined to sign ${r.title}. ${v.sender || "The sender"} has been told.`);
  if (v.state === "closed") return message("This signing link is no longer active", r.status === "cancelled" ? "The request was cancelled by the sender." : r.status === "completed" ? "Everyone has signed already." : "Ask the person who sent it for a new one.");
  if (v.state === "waiting_turn") return message("Not your turn yet", `${r.title} is signed in order. You will get an email when it is your turn.`);
  const fields = fieldsFor(v);
  const ft = await formToken(c, "sign", s.token_hash!);
  const pagesWithFields = [...new Set(fields.map((f) => f.page))].sort((a, b) => a - b);
  const pageSizes = r.pages ? (JSON.parse(r.pages) as { list: { page: number; width: number; height: number }[] }).list : [];
  const pagesHtml = pagesWithFields.map((p) => {
    const size = pageSizes.find((x) => x.page === p);
    const boxes = size ? fields.filter((f) => f.page === p).map((f) => `<span class="box" title="${f.kind === "date" ? "Date" : f.kind === "initials" ? "Your initials" : "Your signature"}" style="left:${(f.x / size.width) * 100}%;top:${(f.y / size.height) * 100}%;width:${(f.w / size.width) * 100}%;height:${(f.h / size.height) * 100}%"></span>`).join("") : "";
    return `<figure class="pg" style="width:200px;margin:0"><img src="/sign/${esc(token)}/page/${p}" alt="Page ${p}" width="200">${boxes}<figcaption class="small muted" style="padding:4px 6px">Page ${p}</figcaption></figure>`;
  }).join("");
  const kinds = fields.map((f) => f.kind);
  const what = [kinds.includes("signature") ? "your signature" : "", kinds.includes("initials") ? "your initials" : "", kinds.includes("date") ? "the date" : ""].filter(Boolean).join(", ");
  const fieldData = esc(JSON.stringify(fields.map((f) => ({ kind: f.kind, w: f.w, h: f.h }))));
  return shell(`Sign ${r.title}`, `<div class="card" id="sign-app" data-ft="${ft}" data-name="${esc(s.name)}" data-fields="${fieldData}">
<p class="muted small">${v.workspace ? `${esc(v.workspace)}: ` : ""}${esc(v.sender || "Someone")} asks you to sign</p>
<h1>${esc(r.title)}</h1>
${r.message ? `<p style="white-space:pre-wrap">${esc(r.message)}</p>` : ""}
<div class="row"><a class="btn sec" href="/sign/${esc(token)}/document" target="_blank" rel="noopener">Open the document</a><span class="muted small">Read it before you sign. This adds ${esc(what)} on ${pagesWithFields.length === 1 ? `page ${pagesWithFields[0]}` : `pages ${pagesWithFields.join(", ")}`}.</span></div>
${pagesHtml ? `<div class="pages">${pagesHtml}</div>` : ""}
<h2>Your signature</h2>
<div class="tabs" role="tablist"><button type="button" role="tab" data-tab="draw" aria-selected="true">Draw</button><button type="button" role="tab" data-tab="type" aria-selected="false">Type</button><button type="button" role="tab" data-tab="upload" aria-selected="false">Upload</button></div>
<div id="p-draw"><canvas id="pad" class="pad" aria-label="Draw your signature here"></canvas><div class="row" style="margin-top:8px"><button type="button" class="sec" id="clear">Clear</button></div></div>
<div id="p-type" class="hidden"><label for="typed-name">Your name</label><input id="typed-name" type="text" maxlength="80"><div role="radiogroup" aria-label="Signature style">${FONTS.map((f) => `<div class="typed" role="radio" tabindex="0" data-font="${f}" style="font-family:'${f}'"></div>`).join("")}</div></div>
<div id="p-upload" class="hidden"><label for="upload">A picture of your signature (PNG or JPG)</label><input id="upload" type="file" accept="image/png,image/jpeg"></div>
<label class="check"><input type="checkbox" id="agree"> <span>I have read this document and I agree to sign it electronically as ${esc(s.name)} (${esc(s.email)}).</span></label>
<p id="status" class="muted" role="status" aria-live="polite"></p>
<div class="row"><button type="button" id="sign" disabled>Sign</button><button type="button" class="bad" id="decline-open">Decline</button></div>
<div id="decline-box" class="hidden"><label for="reason">Why are you declining?</label><textarea id="reason" maxlength="500"></textarea><div class="row"><button type="button" class="bad" id="decline">Decline to sign</button></div></div>
<p class="note">${esc(ESIGN_NOTE)} Signing records the time, your name and email and your country (from your connection), and the document's fingerprint.</p>
</div>`, true);
}

export function esignPublicRoutes() {
  const opens = new RateLimiter(60, 60_000);
  const posts = new RateLimiter(20, 60_000);
  const tooMany = (c: Context<AppEnv>) => c.html(message("Too many requests", "Try again in a minute."), 429, { ...PUBLIC_HEADERS, "retry-after": "60" });
  const gone = (c: Context<AppEnv>) => c.html(message("This signing link is no longer active", "Ask the person who sent it for a new one."), 404, PUBLIC_HEADERS);
  return new Hono<AppEnv>()
    .get("/_/sign.js", () => new Response(SIGN_PAGE_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } }))
    .get("/:token", async (c) => {
      if (!publicOn(c, "esign")) return gone(c);
      if (!opens.take(c.var.ip)) return tooMany(c);
      const v = await findSigner(c.var.deps, c.req.param("token"));
      if (!v) return gone(c);
      await markViewed(c.var.deps, v, countryOf(c.req.raw.headers));
      return c.html(await signerPage(c, v, c.req.param("token")), 200, PUBLIC_HEADERS);
    })
    .get("/:token/document", async (c) => {
      if (!publicOn(c, "esign")) return gone(c);
      if (!opens.take(c.var.ip)) return tooMany(c);
      const v = await findSigner(c.var.deps, c.req.param("token"));
      if (!v || v.state === "closed" || v.state === "declined") return gone(c);
      const bytes = await readKeptFile(c.var.deps, v.r.source_file_id);
      if (!bytes) return gone(c);
      const ascii = v.r.title.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
      return new Response(bytes as BodyInit, { headers: { ...PUBLIC_HEADERS, "content-type": "application/pdf", "content-disposition": `inline; filename="${ascii}"`, "x-content-type-options": "nosniff" } });
    })
    .get("/:token/page/:n", async (c) => {
      if (!publicOn(c, "esign")) return c.body(null, 404);
      if (!opens.take(c.var.ip)) return c.body(null, 429);
      const v = await findSigner(c.var.deps, c.req.param("token"));
      const n = Number(c.req.param("n"));
      if (!v || v.state !== "open" || !Number.isInteger(n) || !fieldsFor(v).some((f) => f.page === n)) return c.body(null, 404);
      const zip = v.r.pages ? (JSON.parse(v.r.pages) as { zip: string | null }).zip : null;
      const img = zip ? (await pageImages(c.var.deps, zip, new Set([n]))).get(n) : undefined;
      if (!img) return c.body(null, 404);
      return new Response(img as BodyInit, { headers: { ...PUBLIC_HEADERS, "content-type": imageType(img), "x-content-type-options": "nosniff" } });
    })
    .post("/:token", async (c) => {
      if (!publicOn(c, "esign")) return c.json({ message: "This signing link is no longer active." }, 404);
      if (!posts.take(c.var.ip)) return c.json({ message: "Too many requests. Try again in a minute." }, 429);
      const v = await findSigner(c.var.deps, c.req.param("token"));
      if (!v) return c.json({ message: "This signing link is no longer active." }, 404);
      const body = (await c.req.json().catch(() => null)) as { ft?: string; action?: string; images?: unknown; reason?: unknown } | null;
      if (!body || !v.s.token_hash || !(await publicPostOk(c, "sign", v.s.token_hash, typeof body.ft === "string" ? body.ft : null))) return c.json({ message: "Request blocked. Open the link again." }, 403);
      const country = countryOf(c.req.raw.headers);
      if (body.action === "decline") {
        const ok = await declineAsSigner(c.var.deps, v, typeof body.reason === "string" ? body.reason : "", country);
        return ok ? c.json({ ok: true }) : c.json({ message: "This link can no longer be used." }, 409);
      }
      if (body.action !== "sign" || !Array.isArray(body.images) || body.images.length > 60 || body.images.some((x) => typeof x !== "string")) return c.json({ message: "Add your signature and try again." }, 400);
      const r = await signAsSigner(c.var.deps, v, body.images as string[], country);
      if (!r.ok) return c.json({ message: r.message }, 409);
      if (r.finished) {
        // On Workers, poll the engine in the background for a short while; the request page and the cron pass pick up the rest.
        const ctx = ((): { waitUntil(p: Promise<unknown>): void } | null => { try { return c.executionCtx; } catch { return null; } })();
        const deps = c.var.deps;
        if (ctx) ctx.waitUntil((async () => {
          for (let i = 0; i < 8; i++) {
            await new Promise((res) => setTimeout(res, 3000));
            const row = await requestRow(deps, v.r.id);
            if (!row || row.status !== "finishing") return;
            await advance(deps, row).catch(() => undefined);
          }
        })());
      }
      return c.json({ ok: true, finished: r.finished });
    });
}
