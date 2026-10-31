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
 * R107 (ESIGN_V2):
 *   GET    /api/tools/esign/templates                 templates of the workspace
 *   POST   /api/tools/esign/:id/template              { name, roles, fields, order, message?, expiresDays?, remindDays? } a draft becomes a template
 *   DELETE /api/tools/esign/templates/:tid            the maker or an admin
 *   POST   /api/tools/esign/templates/:tid/send       { signers, mailboxId, ... } one request
 *   POST   /api/tools/esign/templates/:tid/bulk       { text | rows, mailboxId, ... } one request per person (one role templates)
 *   POST   /api/tools/esign/templates/parse-list      { text } -> { rows, bad } (preview)
 *   GET    /api/tools/esign/:id/record                the full signing record (JSON)
 *   POST   /sign/<token>                     { ft, action: "code_send" } | { ft, action: "code_check", code } | sign with { consent, tz }
 *   GET    /sign/verify, /sign/verify/<sha256>         public check of a signed copy (the browser hashes the PDF)
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { imageType, advance, cancelRequest, declineAsSigner, draftPages, eventsOf, fieldsFor, findSigner, ownRequest, listRequests, markViewed, pageImages, requestDetail, requestFile, requestRow, sendRequest, signAsSigner, signSelf, startDraft, type SignerView } from "../services/tools/esign";
import { countryOf, keptUsage, readKeptFile } from "../services/tools/kept-files";
import { fileOfForm, fromAttachment, fromToolResult, readUploadForm } from "../services/tools/p2-sources";
import { PUBLIC_HEADERS, attachmentDisposition, esc, formToken, gateP2, publicOn, publicPage, publicPostOk } from "../services/tools/p2-public";
import { SIGN_PAGE_JS, VERIFY_PAGE_JS } from "../services/tools/sign-page-script";
import { TOOLS_UPLOAD_HEADER } from "./tools";
import { ESIGN_NOTE, SIGN_BULK_MAX, SIGN_MAX_SIGNERS, type SignField } from "@/shared/share-sign";
import { BULK_MAX_ROWS, bulkSend, checkCode, deleteTemplate, eventCtx, isVerified, listTemplates, maskEmail, parseList, recordJson, saveTemplate, sendCode, sendFromTemplate, verifyByHash } from "../services/tools/esign-v2";

const Field = z.object({ signer: z.number().int().min(0).max(SIGN_MAX_SIGNERS - 1).default(0), kind: z.enum(["signature", "initials", "date", "text", "checkbox"]), page: z.number().int().min(1).max(500), x: z.number().finite(), y: z.number().finite(), w: z.number().finite().positive(), h: z.number().finite().positive(), label: z.string().max(40).optional() });
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
const People = z.array(z.object({ name: z.string().min(1).max(120), email: z.string().min(3).max(254) }));
const TemplateBody = z.object({ name: z.string().min(1).max(80), roles: z.array(z.string().max(40)).min(1).max(SIGN_MAX_SIGNERS), fields: z.array(Field).min(1).max(60),
  order: z.enum(["any", "sequence"]).default("any"), message: z.string().max(2000).optional(), expiresDays: z.number().int().min(1).max(30).default(14), remindDays: z.number().int().min(0).max(14).default(3) });
const TemplateSendBody = z.object({ signers: People.min(1).max(SIGN_MAX_SIGNERS), mailboxId: z.string().max(64).optional(), message: z.string().max(2000).optional(), subject: z.string().max(200).optional(),
  expiresDays: z.number().int().min(1).max(30).optional(), remindDays: z.number().int().min(0).max(14).optional(), order: z.enum(["any", "sequence"]).optional() });
const BulkBody = z.object({ text: z.string().max(20_000).optional(), rows: People.max(SIGN_BULK_MAX).optional(), mailboxId: z.string().max(64).optional(), message: z.string().max(2000).optional(),
  subject: z.string().max(200).optional(), expiresDays: z.number().int().min(1).max(30).optional(), remindDays: z.number().int().min(0).max(14).optional() });
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
    .get("/", async (c) => c.json({ requests: await listRequests(c.var.deps, c.var.auth), usage: await keptUsage(c.var.deps, c.var.auth.orgId), note: ESIGN_NOTE, v2: c.var.deps.config.esignV2 !== false }))
    // R107: templates and bulk send (ESIGN_V2).
    .use("/templates/*", async (c, next) => { if (c.var.deps.config.esignV2 === false) throw new HttpError(404, "not_found", "Not found."); await next(); })
    .get("/templates", async (c) => {
      if (c.var.deps.config.esignV2 === false) return c.json({ templates: [] });
      return c.json({ templates: await listTemplates(c.var.deps, c.var.auth) });
    })
    .post("/templates/parse-list", async (c) => {
      const b = await json(c, z.object({ text: z.string().max(20_000) }));
      const r = parseList(b.text);
      return c.json({ rows: r.rows.slice(0, BULK_MAX_ROWS), bad: r.bad, over: Math.max(0, r.rows.length - BULK_MAX_ROWS) });
    })
    .delete("/templates/:tid", async (c) => c.json(await deleteTemplate(c.var.deps, c.var.auth, c.req.param("tid"), c.var.ip)))
    .post("/templates/:tid/send", async (c) => {
      const b = await json(c, TemplateSendBody);
      return c.json(await sendFromTemplate(c.var.deps, c.var.auth, c.req.param("tid"), b, c.var.ip));
    })
    .post("/templates/:tid/bulk", async (c) => {
      const b = await json(c, BulkBody);
      if (!starts.take(c.var.auth.userId)) throw new HttpError(429, "rate_limited", "Too many sends in the last hour.");
      return c.json(await bulkSend(c.var.deps, c.var.auth, c.req.param("tid"), b, c.var.ip));
    })
    .post("/:id/template", async (c) => {
      if (c.var.deps.config.esignV2 === false) throw new HttpError(404, "not_found", "Not found.");
      const b = await json(c, TemplateBody);
      return c.json(await saveTemplate(c.var.deps, c.var.auth, c.req.param("id"), { ...b, fields: b.fields as SignField[] }, c.var.ip), 201);
    })
    .get("/:id/record", async (c) => {
      const r = await ownRequest(c.var.deps, c.var.auth, c.req.param("id"));
      const body = JSON.stringify(await recordJson(c.var.deps, r, await eventsOf(c.var.deps, r.id)), null, 2);
      const name = `${r.title.replace(/\.pdf$/i, "")} (signing record).json`;
      return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": attachmentDisposition(name), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    })
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
const fontCss = FONTS.map((f) => `@font-face{font-family:'${f}';src:url(/fonts/sign/${FONT_FILES[f]}.woff2) format('woff2');font-display:swap}`).join("")
  // R107: the three steps of a v2 signing page, and 44px tap targets on phones.
  + ".steps{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:12px 0 4px}.steps li{font-size:13px;padding:4px 12px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}"
  + ".steps li[aria-current]{border-color:var(--brand);color:var(--fg);font-weight:600}.steps li.done{color:var(--good)}.steps li.done::before{content:'\\2713  '}"
  + "#code{font-size:24px;letter-spacing:6px;max-width:220px;font-variant-numeric:tabular-nums}"
  + "@media (max-width:480px){#sign-app button,#idv-app button,.check input{min-height:44px}.check input{min-width:24px}}";

function shell(title: string, inner: string, script: boolean | string = false) {
  return publicPage(title, `<style>${fontCss}</style><header class="top"><span class="brand">Multies</span></header><main class="wide">${inner}</main>`, script ? { script: typeof script === "string" ? script : "/sign/_/sign.js" } : {});
}

function message(title: string, text: string) {
  return shell(title, `<div class="card"><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p><p class="note">${esc(ESIGN_NOTE)}</p></div>`);
}

const dateText = (ms: number | null) => (ms ? new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "");

async function signerPage(c: Context<AppEnv>, v: SignerView, token: string) {
  const { r, s } = v;
  if (v.state === "signed") {
    // R67 (QA5 #17): the last signer is told everyone has signed, not to wait for the others.
    const allSigned = r.status === "completed" || (v.signers.length > 0 && v.signers.every((x) => x.status === "signed"));
    return message("You have signed", `You signed ${r.title} on ${dateText(s.signed_at)}. ${r.status === "completed" ? "Everyone has signed. The signed copy was emailed to you." : allSigned ? "Everyone has signed. The signed copy is on its way to your email." : "When everyone has signed, the signed copy is emailed to you."}`);
  }
  if (v.state === "declined") return message("You declined to sign", `You declined to sign ${r.title}. ${v.sender || "The sender"} has been told.`);
  if (v.state === "closed") return message("This signing link is no longer active", r.status === "cancelled" ? "The request was cancelled by the sender." : r.status === "completed" ? "Everyone has signed already." : "Ask the person who sent it for a new one.");
  if (v.state === "waiting_turn") return message("Not your turn yet", `${r.title} is signed in order. You will get an email when it is your turn.`);
  const fields = fieldsFor(v);
  const ft = await formToken(c, "sign", s.token_hash!);
  // R107: a v2 request first confirms the signer by a code to their email (bound to this link).
  const verified = !r.v2 || isVerified(s, c.var.deps.now().getTime());
  if (!verified) {
    return shell(`Sign ${r.title}`, `<div class="card" id="idv-app" data-ft="${ft}">
<p class="muted small">${v.workspace ? `${esc(v.workspace)}: ` : ""}${esc(v.sender || "Someone")} asks you to sign</p>
<h1>${esc(r.title)}</h1>
<ol class="steps" aria-label="Steps"><li aria-current="step">Confirm it is you</li><li>Read</li><li>Sign</li></ol>
<h2>Confirm it is you</h2>
<p>We will email a 6 digit code to ${esc(maskEmail(s.email))}. It works once, for 10 minutes.</p>
<div class="row"><button type="button" id="code-send">Email me a code</button></div>
<div id="code-box" class="hidden"><label for="code">Code from the email</label><input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*">
<div class="row"><button type="button" id="code-check">Confirm</button><button type="button" class="sec" id="code-again">Send a new code</button></div></div>
<p id="status" class="muted" role="status" aria-live="polite"></p>
<p class="note">${esc(ESIGN_NOTE)} The code shows the document is signed by the person it was sent to.</p>
</div>`, true);
  }
  const extras = fields.map((f, i) => ({ f, i })).filter(({ f }) => f.kind === "text" || f.kind === "checkbox");
  const extrasHtml = extras.length ? `<h2>Fill in</h2>${extras.map(({ f, i }, n) => f.kind === "text"
    ? `<label for="fx-${i}">${esc(f.label || `Text ${n + 1}`)}</label><input id="fx-${i}" data-fx="${i}" type="text" maxlength="60" required>`
    : `<label class="check"><input type="checkbox" id="fx-${i}" data-fx="${i}"> <span>${esc(f.label || "Tick if this applies")}</span></label>`).join("")}` : "";
  const pagesWithFields = [...new Set(fields.map((f) => f.page))].sort((a, b) => a - b);
  const pageSizes = r.pages ? (JSON.parse(r.pages) as { list: { page: number; width: number; height: number }[] }).list : [];
  const pagesHtml = pagesWithFields.map((p) => {
    const size = pageSizes.find((x) => x.page === p);
    const boxes = size ? fields.filter((f) => f.page === p).map((f) => `<span class="box" title="${f.kind === "date" ? "Date" : f.kind === "initials" ? "Your initials" : f.kind === "text" ? esc(f.label || "Text") : f.kind === "checkbox" ? esc(f.label || "Checkbox") : "Your signature"}" style="left:${(f.x / size.width) * 100}%;top:${(f.y / size.height) * 100}%;width:${(f.w / size.width) * 100}%;height:${(f.h / size.height) * 100}%"></span>`).join("") : "";
    // R67 (QA5 #17): a page keeps a readable width on a phone (swipe sideways inside its frame) and opens full size on tap.
    return `<div class="pgwrap"><figure class="pg"><a href="/sign/${esc(token)}/page/${p}" target="_blank" rel="noopener" aria-label="Open page ${p} full size"><img src="/sign/${esc(token)}/page/${p}" alt="Page ${p}" style="display:block;width:100%;height:auto"></a>${boxes}<figcaption class="small muted" style="padding:4px 6px">Page ${p}</figcaption></figure></div>`;
  }).join("");
  const pageCss = `<style>.pages{flex-direction:column;flex-wrap:nowrap}.pgwrap{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}.pgwrap .pg{width:100%;max-width:640px;margin:0}.pgwrap .box{pointer-events:none}.pghint{display:none}@media (max-width:600px){.pgwrap .pg{width:560px;max-width:none}.pghint{display:block}}</style>`;
  const kinds = fields.map((f) => f.kind);
  const what = [kinds.includes("signature") ? "your signature" : "", kinds.includes("initials") ? "your initials" : "", kinds.includes("date") ? "the date" : "", extras.length ? "what you fill in" : ""].filter(Boolean).join(", ");
  const fieldData = esc(JSON.stringify(fields.map((f) => ({ kind: f.kind, w: f.w, h: f.h }))));
  const tzField = r.v2 ? ` data-v2="1"` : "";
  return shell(`Sign ${r.title}`, `<div class="card" id="sign-app" data-ft="${ft}" data-name="${esc(s.name)}" data-fields="${fieldData}"${tzField}>
<p class="muted small">${v.workspace ? `${esc(v.workspace)}: ` : ""}${esc(v.sender || "Someone")} asks you to sign</p>
<h1>${esc(r.title)}</h1>
${r.message ? `<p style="white-space:pre-wrap">${esc(r.message)}</p>` : ""}
<div class="row"><a class="btn sec" href="/sign/${esc(token)}/document" target="_blank" rel="noopener">Open the document</a><span class="muted small">Read it before you sign. This adds ${esc(what)} on ${pagesWithFields.length === 1 ? `page ${pagesWithFields[0]}` : `pages ${pagesWithFields.join(", ")}`}.</span></div>
${pagesHtml ? `${pageCss}<p class="pghint muted small">Swipe sideways to read the whole page, or tap it to open it full size.</p><div class="pages">${pagesHtml}</div>` : ""}
${r.v2 ? `<ol class="steps" aria-label="Steps"><li class="done">Confirm it is you</li><li aria-current="step">Read</li><li>Sign</li></ol><p class="muted small">Identity checked by a code to ${esc(maskEmail(s.email))}.</p>` : ""}
${extrasHtml}
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
  const checks = new RateLimiter(20, 60_000);
  const tooMany = (c: Context<AppEnv>) => c.html(message("Too many requests", "Try again in a minute."), 429, { ...PUBLIC_HEADERS, "retry-after": "60" });
  const gone = (c: Context<AppEnv>) => c.html(message("This signing link is no longer active", "Ask the person who sent it for a new one."), 404, PUBLIC_HEADERS);
  return new Hono<AppEnv>()
    .get("/_/sign.js", () => new Response(SIGN_PAGE_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } }))
    // R107: anyone holding a signed copy can check it; the PDF is hashed in the browser and only the hash is sent.
    .get("/_/verify.js", () => new Response(VERIFY_PAGE_JS, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } }))
    .get("/verify", (c) => {
      if (!publicOn(c, "esign") || c.var.deps.config.esignV2 === false) return gone(c);
      return c.html(shell("Check a signed document", `<div class="card"><h1>Check a signed document</h1>
<p class="muted">Choose a PDF that was signed with Multies. It stays on your device: only its fingerprint (SHA-256) is checked.</p>
<label for="vf">Signed PDF</label><input id="vf" type="file" accept="application/pdf,.pdf">
<p id="status" class="muted" role="status" aria-live="polite"></p><div id="result"></div>
<p class="note">A match means this exact file is the copy made when everyone signed. Any change to the file, even one character, gives a different fingerprint.</p></div>`, "/sign/_/verify.js"), 200, PUBLIC_HEADERS);
    })
    .get("/verify/:sha", async (c) => {
      if (!publicOn(c, "esign") || c.var.deps.config.esignV2 === false) return c.json({ message: "Not found." }, 404);
      if (!checks.take(c.var.ip)) return c.json({ message: "Too many checks. Try again in a minute." }, 429);
      const sha = c.req.param("sha").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha)) return c.json({ message: "That is not a document fingerprint." }, 400);
      return c.json(await verifyByHash(c.var.deps, sha), 200, { "cache-control": "no-store" });
    })
    .get("/:token", async (c) => {
      if (!publicOn(c, "esign")) return gone(c);
      if (!opens.take(c.var.ip)) return tooMany(c);
      const v = await findSigner(c.var.deps, c.req.param("token"));
      if (!v) return gone(c);
      await markViewed(c.var.deps, v, countryOf(c.req.raw.headers), await eventCtx(c.var.deps, c.req.raw, c.var.ip));
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
      const body = (await c.req.json().catch(() => null)) as { ft?: string; action?: string; images?: unknown; reason?: unknown; code?: unknown; consent?: unknown; tz?: unknown } | null;
      if (!body || !v.s.token_hash || !(await publicPostOk(c, "sign", v.s.token_hash, typeof body.ft === "string" ? body.ft : null))) return c.json({ message: "Request blocked. Open the link again." }, 403);
      const country = countryOf(c.req.raw.headers);
      const ctx = await eventCtx(c.var.deps, c.req.raw, c.var.ip, body.tz);
      // R107: the email code (v2 requests only).
      if (body.action === "code_send" || body.action === "code_check") {
        if (!v.r.v2) return c.json({ message: "This link does not use a code." }, 400);
        const res = body.action === "code_send" ? await sendCode(c.var.deps, v, { ...ctx, ipCountry: country } as typeof ctx) : await checkCode(c.var.deps, v, body.code, ctx);
        if (res.ok) return c.json({ ok: true, message: res.message ?? null });
        return c.json({ message: res.message }, (res.status ?? 400) as 400, res.retryAfter ? { "retry-after": String(res.retryAfter) } : undefined);
      }
      if (body.action === "decline") {
        if (v.r.v2 && !isVerified(v.s, c.var.deps.now().getTime())) return c.json({ message: "Confirm it is you with the code we email you first." }, 403);
        const ok = await declineAsSigner(c.var.deps, v, typeof body.reason === "string" ? body.reason : "", country, ctx);
        return ok ? c.json({ ok: true }) : c.json({ message: "This link can no longer be used." }, 409);
      }
      if (body.action !== "sign" || !Array.isArray(body.images) || body.images.length > 60 || body.images.some((x) => typeof x !== "string")) return c.json({ message: "Add your signature and try again." }, 400);
      const r = await signAsSigner(c.var.deps, v, body.images as string[], country, { ctx, consent: body.consent === true });
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
