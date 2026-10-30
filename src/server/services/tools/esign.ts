/**
 * Tools P2 (H5): e-sign. Two kinds:
 *  - "self": a person signs a PDF themselves (draw, type or upload; date and initials too); the engine sign op
 *    places the images and the finished PDF is kept for download until the request expires.
 *  - "request": signers (name, email; any order or in sequence) each get their own link (/sign/<token>, 32
 *    random bytes, only the SHA-256 stored) by email from the person's own mailbox, in the same thread when
 *    started from one. A link works once (sign or decline) and until the request expires (30 days at most).
 *    When everyone has signed, the engine sign op places every signature and adds the signing record page
 *    (events with UTC time, name, email, action, IP country, and the document's SHA-256), and the finished PDF
 *    goes back into the thread to everyone as an attachment.
 * D1 holds the record: sign_requests, sign_signers, sign_events. The PDFs live in KV with the request's expiry
 * (finished copies live on in the email thread). Engine jobs are polled, never awaited in a long request: the
 * request page, the signer who signs last (in the background) and the cron pass (runSignPass) move them on.
 */
import { sql } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import type { AuthContext, Deps } from "../../context";
import { HttpError, badRequest, notFound } from "../../lib/errors";
import { fromB64, newId, sha256HexBytes } from "../../lib/crypto";
import { audit } from "../audit";
import { mailboxScope } from "../team";
import { sendSystemEmail } from "../system-mail";
import { changesOf, dropKeptFiles, keepFile, newPublicToken, readKeptFile, tokenHash, tokenShapeOk, hashMatches } from "./kept-files";
import { engineJobOutput, engineJobState, submitEngineJob, type EngineFile } from "./engine-run";

/** The engine reads signature pictures from this form field (GET /internal/v1/operations, sign extra_files). */
const SIGN_IMAGES_FIELD = "images";
import { isPdf, type SourceFile } from "./p2-sources";
import { cleanName } from "./share";
import { SIGN_MAX_DAYS, SIGN_MAX_PAGES, SIGN_MAX_SIGNERS, type SignEventRow, type SignField, type SignPage, type SignRequestInfo, type SignRequestStatus, type SignSignerInfo, type SignerStatus } from "@/shared/share-sign";

export interface RequestRow {
  id: string; org_id: string; created_by: string; kind: "self" | "request"; status: SignRequestStatus; title: string; subject: string | null; message: string | null;
  mailbox_id: string | null; in_reply_to_id: string | null; order_mode: "any" | "sequence"; fields: string | null; pages: string | null;
  source_file_id: string; source_sha256: string; final_file_id: string | null; final_sha256: string | null; engine_job: string | null; engine_kind: string | null;
  remind_days: number; error: string | null; expires_at: number; sent_at: number | null; completed_at: number | null; created_at: number;
}
export interface SignerRow {
  id: string; request_id: string; org_id: string; position: number; name: string; email: string; token_hash: string | null; status: SignerStatus;
  sent_at: number | null; reminded_at: number | null; viewed_at: number | null; signed_at: number | null; declined_at: number | null; decline_reason: string | null; signature_file_ids: string | null;
}
export interface EventRow { id: string; request_id: string; org_id: string; seq: number; at: number; signer_id: string | null; name: string; email: string; action: string; ip_country: string | null; detail: string | null }
interface PagesInfo { zip: string | null; list: SignPage[] }

/** Drafts (a document waiting to be placed) are kept a day; a request lives as long as the sender chose. */
const DRAFT_SECONDS = 86_400;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

// ---------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------
export async function requestRow(deps: Deps, id: string): Promise<RequestRow | null> {
  return (await deps.db.get<RequestRow>(sql`select * from sign_requests where id = ${id}`)) ?? null;
}
async function ownRequest(deps: Deps, auth: AuthContext, id: string): Promise<RequestRow> {
  const r = await deps.db.get<RequestRow>(sql`select * from sign_requests where id = ${id} and org_id = ${auth.orgId}`);
  if (!r || (auth.role === "member" && r.created_by !== auth.userId)) throw notFound("Signing request");
  return r;
}
export async function signersOf(deps: Deps, requestId: string): Promise<SignerRow[]> {
  return deps.db.all<SignerRow>(sql`select * from sign_signers where request_id = ${requestId} order by position`);
}
export async function eventsOf(deps: Deps, requestId: string): Promise<EventRow[]> {
  return deps.db.all<EventRow>(sql`select * from sign_events where request_id = ${requestId} order by seq`);
}

/** One event row; seq is the next number for the request, taken in the same statement. */
export async function addEvent(deps: Deps, r: Pick<RequestRow, "id" | "org_id">, e: { signerId?: string | null; name: string; email: string; action: string; ipCountry?: string | null; detail?: string | null }) {
  const now = deps.now().getTime();
  await deps.db.run(sql`insert into sign_events (id, request_id, org_id, seq, at, signer_id, name, email, action, ip_country, detail)
    select ${newId("sev")}, ${r.id}, ${r.org_id}, coalesce(max(seq), 0) + 1, ${now}, ${e.signerId ?? null}, ${e.name.slice(0, 120)}, ${e.email.slice(0, 254)}, ${e.action}, ${e.ipCountry ?? null}, ${e.detail ?? null}
    from sign_events where request_id = ${r.id}`);
}

const ACTION_TEXT: Record<string, string> = {
  created: "Created the request", sent: "Sent the signing link", viewed: "Opened the document", signed: "Signed", declined: "Declined",
  reminded: "Sent a reminder", completed: "Everyone signed; finished copy made", cancelled: "Cancelled the request", self_signed: "Signed",
};
export const actionText = (a: string) => ACTION_TEXT[a] ?? a;

function signerInfo(s: SignerRow): SignSignerInfo {
  return { id: s.id, position: s.position, name: s.name, email: s.email, status: s.status, sentAt: iso(s.sent_at), viewedAt: iso(s.viewed_at), signedAt: iso(s.signed_at), declinedAt: iso(s.declined_at), declineReason: s.decline_reason };
}

function info(r: RequestRow, signers: SignerRow[], events?: EventRow[]): SignRequestInfo {
  const out: SignRequestInfo = {
    id: r.id, kind: r.kind, status: r.status, title: r.title, orderMode: r.order_mode, createdAt: iso(r.created_at)!, expiresAt: iso(r.expires_at)!,
    completedAt: iso(r.completed_at), sourceSha256: r.source_sha256, finalSha256: r.final_sha256, error: r.error, signers: signers.map(signerInfo),
  };
  if (r.status === "out") out.waitingOn = signers.filter((s) => s.status !== "signed" && turnOf(r, signers, s)).map((s) => s.name);
  if (events) out.events = events.map((e): SignEventRow => ({ at: iso(e.at)!, name: e.name, email: e.email, action: e.action, ipCountry: e.ip_country, detail: e.detail }));
  if (r.final_file_id && r.status === "completed") out.downloadUrl = `/api/tools/esign/${r.id}/download`;
  return out;
}

/** Whether it is this signer's turn: always in "any" order; in sequence, once everyone before has signed. */
export function turnOf(r: Pick<RequestRow, "order_mode">, signers: SignerRow[], s: SignerRow): boolean {
  if (r.order_mode !== "sequence") return true;
  return signers.filter((o) => o.position < s.position).every((o) => o.status === "signed");
}

// ---------------------------------------------------------------------------
// Starting: a document becomes a draft and its pages are rendered by the engine (thumbnails op)
// ---------------------------------------------------------------------------
export async function startDraft(deps: Deps, auth: AuthContext, file: SourceFile, ip?: string): Promise<SignRequestInfo & { pages: null }> {
  if (!isPdf(file.bytes)) throw new HttpError(422, "tool_input", "Choose a PDF to sign.");
  const sha = await sha256HexBytes(file.bytes.slice().buffer as ArrayBuffer);
  const fileId = await keepFile(deps, auth.orgId, "sign_source", file.bytes, DRAFT_SECONDS, { name: cleanName(file.name) });
  const now = deps.now().getTime();
  const id = newId("sgn");
  // Sharp previews (pages at 72 dpi, one image pixel per PDF point) when the page count is readable and small; the
  // small thumbnails op otherwise (its 200 pixel pages looked blurry behind the signature fields on staging).
  const count = mediaBoxes(file.bytes).length;
  const sharp = count > 0 && count <= SHARP_PREVIEW_PAGES;
  const job = await submitEngineJob(deps, auth.orgId, auth.userId, sharp ? "to-jpeg" : "thumbnails", [{ name: "document.pdf", type: "application/pdf", bytes: file.bytes }], sharp ? { dpi: "72" } : {}).catch(() => null);
  // A thread message the document came from becomes the default thread for a request.
  await deps.db.run(sql`insert into sign_requests (id, org_id, created_by, kind, status, title, in_reply_to_id, source_file_id, source_sha256, engine_job, engine_kind, expires_at, created_at)
    values (${id}, ${auth.orgId}, ${auth.userId}, 'self', 'draft', ${cleanName(file.name)}, ${file.messageId ?? null}, ${fileId}, ${sha}, ${job}, ${job ? "thumbs" : null}, ${now + DRAFT_SECONDS * 1000}, ${now})`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_started", targetType: "sign_request", targetId: id, metadata: { bytes: file.bytes.byteLength }, ip });
  const r = (await requestRow(deps, id))!;
  return { ...info(r, []), pages: null };
}

/** Page sizes and small page images for placing fields. Answers { status: "working" } until the engine is done. */
export async function draftPages(deps: Deps, auth: AuthContext, id: string): Promise<{ status: "working" | "done" | "failed"; pages?: SignPage[]; error?: string }> {
  const r = await ownRequest(deps, auth, id);
  let pages = r.pages ? (JSON.parse(r.pages) as PagesInfo) : null;
  if (!pages) {
    if (!r.engine_job || r.engine_kind !== "thumbs") return { status: "failed", error: "Page previews are not available. Try again." };
    const st = await engineJobState(deps, r.org_id, auth.userId, r.engine_job);
    if (st.status === "queued" || st.status === "running") return { status: "working" };
    if (st.status !== "done") return { status: "failed", error: st.error || "That PDF could not be read." };
    const zip = await engineJobOutput(deps, r.org_id, auth.userId, r.engine_job);
    if (!zip) return { status: "failed", error: "Page previews expired. Open the document again." };
    const pdf = await readKeptFile(deps, r.source_file_id);
    const list = pageListFromZip(zip, pdf);
    if (!list.length) return { status: "failed", error: "That PDF has no pages we could read." };
    const ttl = Math.max(60, Math.ceil((r.expires_at - deps.now().getTime()) / 1000));
    const zipId = await keepFile(deps, r.org_id, "sign_image", zip, ttl).catch(() => null);
    pages = { zip: zipId, list };
    await deps.db.run(sql`update sign_requests set pages = ${JSON.stringify(pages)}, engine_job = null, engine_kind = null where id = ${r.id}`);
  }
  const imgs = pages.zip ? await pageImages(deps, pages.zip) : new Map<number, Uint8Array>();
  return { status: "done", pages: pages.list.map((p) => ({ ...p, img: imgs.has(p.page) ? `data:${imageType(imgs.get(p.page)!)};base64,${b64(imgs.get(p.page)!)}` : undefined })) };
}

function b64(u: Uint8Array) {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Pages at or under this count get sharp 72 dpi previews (about 60 KB a page) instead of 200 pixel thumbnails. */
export const SHARP_PREVIEW_PAGES = 30;
/** A page picture in a previews zip: page-001.png (thumbnails) or page-p1.jpg (PDF to images). */
const PAGE_IMG = /page-p?(\d+)\.(?:png|jpe?g)$/;
/** The picture's type from its first bytes. */
export const imageType = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : "image/png");

/** Page pictures from a previews zip (page-001.png or page-p1.jpg ...), by page number. */
export async function pageImages(deps: Deps, zipId: string, only?: Set<number>): Promise<Map<number, Uint8Array>> {
  const zip = await readKeptFile(deps, zipId);
  const out = new Map<number, Uint8Array>();
  if (!zip) return out;
  try {
    const files = unzipSync(zip, { filter: (f) => { const m = f.name.match(PAGE_IMG); return !!m && (!only || only.has(Number(m[1]))); } });
    for (const [name, data] of Object.entries(files)) out.set(Number(name.match(PAGE_IMG)![1]), data);
  } catch { /* not a zip */ }
  return out;
}

/** Page sizes in PDF points: the engine's pages.json when it sends one, else the PDF's MediaBox, else A4 or Letter by the picture's shape. */
export function pageListFromZip(zip: Uint8Array, pdf: Uint8Array | null): SignPage[] {
  let files: Record<string, Uint8Array> = {};
  try { files = unzipSync(zip, { filter: (f) => PAGE_IMG.test(f.name) || f.name === "pages.json" }); } catch { return []; }
  const pngs = Object.keys(files).filter((n) => PAGE_IMG.test(n)).map((n) => Number(n.match(PAGE_IMG)![1])).sort((a, b) => a - b).slice(0, SIGN_MAX_PAGES);
  if (files["pages.json"]) {
    try {
      const list = (JSON.parse(strFromU8(files["pages.json"])) as { page: number; width: number; height: number }[])
        .filter((p) => Number.isFinite(p.page) && p.width > 0 && p.height > 0).map((p) => ({ page: p.page, width: p.width, height: p.height }));
      if (list.length) return list.slice(0, SIGN_MAX_PAGES);
    } catch { /* fall back */ }
  }
  const boxes = pdf ? mediaBoxes(pdf) : [];
  return pngs.map((page, i) => {
    const b = boxes.length === pngs.length ? boxes[i] : null;
    if (b) return { page, width: b[0], height: b[1] };
    const [w, h] = pngSize(files[`page-${String(page).padStart(3, "0")}.png`] ?? Object.values(files)[i]) ?? [200, 283];
    return { page, ...guessSize(w, h) };
  });
}

export function pngSize(b: Uint8Array | undefined): [number, number] | null {
  if (!b || b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [dv.getUint32(16), dv.getUint32(20)];
}

function guessSize(w: number, h: number) {
  const land = w > h;
  const r = land ? w / h : h / w;
  const [short, long] = Math.abs(r - 1.294) < 0.03 ? [612, 792] : Math.abs(r - 1.414) < 0.04 ? [595.28, 841.89] : [612, Math.round(612 * r)];
  return land ? { width: long, height: short } : { width: short, height: long };
}

/** Page sizes from a PDF's own page dictionaries, when they are readable as text (not in object streams). */
export function mediaBoxes(pdf: Uint8Array): [number, number][] {
  const text = new TextDecoder("latin1").decode(pdf.length > 8 * 1024 * 1024 ? pdf.subarray(0, 8 * 1024 * 1024) : pdf);
  const out: [number, number][] = [];
  // Each page object, wherever /Type /Page sits in it (some writers put /MediaBox before /Type, so read the whole object).
  const re = /\bobj\b([\s\S]{0,4000}?)\bendobj\b/g;
  const inherited = text.match(/\/Type\s*\/Pages[\s\S]{0,2000}?\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < SIGN_MAX_PAGES) {
    if (!/\/Type\s*\/Page(?![s\w])/.test(m[1])) continue;
    const box = m[1].match(/\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/) ?? inherited;
    if (!box) return [];
    let w = Number(box[3]) - Number(box[1]), h = Number(box[4]) - Number(box[2]);
    const rot = m[1].match(/\/Rotate\s+(-?\d+)/);
    if (rot && Math.abs(Number(rot[1])) % 180 === 90) [w, h] = [h, w];
    if (!(w > 0 && h > 0)) return [];
    out.push([w, h]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fields and signature pictures
// ---------------------------------------------------------------------------
const MAX_PNG = 300 * 1024;

export function pngFromDataUrl(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !v.startsWith("data:image/png;base64,") || v.length > MAX_PNG * 1.4) return null;
  let b: Uint8Array;
  try { b = fromB64(v.slice(22)); } catch { return null; }
  const size = pngSize(b);
  if (!size || size[0] < 4 || size[1] < 4 || size[0] > 4000 || size[1] > 4000 || b.byteLength > MAX_PNG) return null;
  return b;
}

export function checkFields(fields: SignField[], pages: SignPage[], signerCount: number): SignField[] {
  if (!fields.length || fields.length > 60) throw badRequest("Place at least one signature field.");
  const byPage = new Map(pages.map((p) => [p.page, p]));
  return fields.map((f) => {
    const p = byPage.get(f.page);
    if (!p) throw badRequest("A field is on a page the document does not have.");
    if (!Number.isInteger(f.signer) || f.signer < 0 || f.signer >= Math.max(1, signerCount)) throw badRequest("Each field needs a signer.");
    if (!["signature", "initials", "date"].includes(f.kind)) throw badRequest("Unknown field.");
    const x = Math.max(0, f.x), y = Math.max(0, f.y);
    const w = Math.min(f.w, p.width - x), h = Math.min(f.h, p.height - y);
    if (!(w >= 10 && h >= 6)) throw badRequest("A field is too small or off the page.");
    return { signer: f.signer, kind: f.kind, page: f.page, x: round(x), y: round(y), w: round(w), h: round(h) };
  });
}
const round = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Sign yourself
// ---------------------------------------------------------------------------
export async function signSelf(deps: Deps, auth: AuthContext, id: string, input: { fields: SignField[]; images: string[] }, ip?: string): Promise<SignRequestInfo> {
  const r = await ownRequest(deps, auth, id);
  if (r.status !== "draft") throw badRequest("This document has already been used. Open it again to sign.");
  const pages = r.pages ? (JSON.parse(r.pages) as PagesInfo).list : null;
  if (!pages) throw badRequest("The pages are still loading. Try again in a moment.");
  const fields = checkFields(input.fields.map((f) => ({ ...f, signer: 0 })), pages, 1);
  if (input.images.length !== fields.length) throw badRequest("Each field needs its picture.");
  const pngs = input.images.map((v) => pngFromDataUrl(v) ?? (() => { throw badRequest("A signature picture could not be read."); })());
  const src = await readKeptFile(deps, r.source_file_id);
  if (!src) throw new HttpError(410, "gone", "This document has expired. Open it again.");
  const sigs = fields.map((f, i) => ({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, image: i, kind: f.kind, name: auth.name || auth.email, date: deps.now().toISOString().slice(0, 10) }));
  const job = await submitEngineJob(deps, r.org_id, auth.userId, "sign", [{ name: "document.pdf", type: "application/pdf", bytes: src }, ...pngs.map((b, i) => ({ name: `sig-${i}.png`, type: "image/png", bytes: b, field: SIGN_IMAGES_FIELD }))], { signatures: JSON.stringify(sigs) });
  await deps.db.run(sql`update sign_requests set status = 'finishing', kind = 'self', fields = ${JSON.stringify(fields)}, engine_job = ${job}, engine_kind = 'sign', expires_at = ${deps.now().getTime() + DRAFT_SECONDS * 1000} where id = ${r.id}`);
  await addEvent(deps, r, { name: auth.name || auth.email, email: auth.email, action: "self_signed", ipCountry: null });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_self", targetType: "sign_request", targetId: r.id, ip });
  return requestDetail(deps, auth, r.id);
}

// ---------------------------------------------------------------------------
// Request signatures
// ---------------------------------------------------------------------------
export interface SendInput {
  signers: { name: string; email: string }[];
  order: "any" | "sequence";
  fields: SignField[];
  message?: string;
  subject?: string;
  mailboxId?: string;
  inReplyToId?: string | null;
  expiresDays: number;
  remindDays: number;
}

export async function sendRequest(deps: Deps, auth: AuthContext, id: string, input: SendInput, ip?: string): Promise<SignRequestInfo> {
  const r = await ownRequest(deps, auth, id);
  if (r.status !== "draft") throw badRequest("This document has already been sent or signed. Open it again to start a new request.");
  const pages = r.pages ? (JSON.parse(r.pages) as PagesInfo).list : null;
  if (!pages) throw badRequest("The pages are still loading. Try again in a moment.");
  const signers = input.signers.map((s) => ({ name: s.name.trim().slice(0, 120), email: s.email.trim().toLowerCase() }));
  if (!signers.length || signers.length > SIGN_MAX_SIGNERS) throw badRequest(`Add 1 to ${SIGN_MAX_SIGNERS} signers.`);
  if (signers.some((s) => !s.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email))) throw badRequest("Each signer needs a name and an email address.");
  if (new Set(signers.map((s) => s.email)).size !== signers.length) throw badRequest("Each signer needs their own email address.");
  const fields = checkFields(input.fields, pages, signers.length);
  for (let i = 0; i < signers.length; i++) if (!fields.some((f) => f.signer === i && f.kind === "signature")) throw badRequest(`Place a signature field for ${signers[i].name}.`);
  const days = Math.floor(input.expiresDays);
  if (!(days >= 1 && days <= SIGN_MAX_DAYS)) throw badRequest(`Choose 1 to ${SIGN_MAX_DAYS} days for the request.`);
  const remind = Math.max(0, Math.min(14, Math.floor(input.remindDays || 0)));

  // The thread: the message the person replies to (the attachment's message by default), in their mailbox scope.
  const scope = await mailboxScope(deps.db, auth);
  const parentId = input.inReplyToId === undefined ? r.in_reply_to_id : input.inReplyToId;
  let parent: { id: string; mailbox_id: string; subject: string } | undefined;
  if (parentId) {
    parent = await deps.db.get<{ id: string; mailbox_id: string; subject: string }>(sql`select id, mailbox_id, subject from messages where id = ${parentId} and org_id = ${auth.orgId}`);
    if (!parent || (scope && !scope.includes(parent.mailbox_id))) throw notFound("Message");
  }
  const mailboxId = input.mailboxId || parent?.mailbox_id;
  if (!mailboxId) throw badRequest("Choose the mailbox the request is sent from.");
  if (scope && !scope.includes(mailboxId)) throw notFound("Mailbox");
  const mb = await deps.db.get<{ id: string }>(sql`select id from mailboxes where id = ${mailboxId} and org_id = ${auth.orgId}`);
  if (!mb) throw notFound("Mailbox");
  const subject = (input.subject?.trim() || (parent ? (/^re:/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`) : `Please sign: ${r.title}`)).slice(0, 200);

  const now = deps.now().getTime();
  const until = now + days * 86_400_000;
  const ttl = Math.ceil((until - now) / 1000) + 3600;
  // The document now lives as long as the request: kept again under the request's expiry.
  const src = await readKeptFile(deps, r.source_file_id);
  if (!src) throw new HttpError(410, "gone", "This document has expired. Open it again.");
  const newSource = await keepFile(deps, r.org_id, "sign_source", src, ttl, { name: r.title });
  const oldSource = r.source_file_id;
  let pagesJson = r.pages;
  const pinfo = JSON.parse(r.pages!) as PagesInfo;
  if (pinfo.zip) {
    const z = await readKeptFile(deps, pinfo.zip);
    const zipId = z ? await keepFile(deps, r.org_id, "sign_image", z, ttl).catch(() => null) : null;
    if (zipId) { await dropKeptFiles(deps, r.org_id, [pinfo.zip]); pagesJson = JSON.stringify({ ...pinfo, zip: zipId }); }
  }
  await dropKeptFiles(deps, r.org_id, [oldSource]);
  await deps.db.run(sql`update sign_requests set kind = 'request', status = 'out', subject = ${subject}, message = ${(input.message ?? "").slice(0, 2000) || null},
    mailbox_id = ${mailboxId}, in_reply_to_id = ${parent?.id ?? null}, order_mode = ${input.order === "sequence" ? "sequence" : "any"}, fields = ${JSON.stringify(fields)},
    pages = ${pagesJson}, source_file_id = ${newSource}, remind_days = ${remind}, expires_at = ${until}, sent_at = ${now} where id = ${r.id}`);
  for (let i = 0; i < signers.length; i++) {
    await deps.db.run(sql`insert into sign_signers (id, request_id, org_id, position, name, email, status) values (${newId("ssg")}, ${r.id}, ${r.org_id}, ${i}, ${signers[i].name}, ${signers[i].email}, 'waiting')`);
  }
  await addEvent(deps, r, { name: auth.name || auth.email, email: auth.email, action: "created", detail: `${signers.length} ${signers.length === 1 ? "signer" : "signers"}, ${input.order === "sequence" ? "in order" : "any order"}` });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_requested", targetType: "sign_request", targetId: r.id, metadata: { signers: signers.length, order: input.order, days }, ip });
  const fresh = (await requestRow(deps, r.id))!;
  await sendDueLinks(deps, fresh);
  return requestDetail(deps, auth, r.id);
}

/** The person who made the request, as the sender of its mail. */
async function senderAuth(deps: Deps, r: RequestRow): Promise<AuthContext> {
  const u = await deps.db.get<{ id: string; email: string; name: string; role: "owner" | "admin" | "member" }>(sql`select u.id as id, u.email as email, u.name as name, m.role as role
    from users u join members m on m.user_id = u.id and m.organization_id = ${r.org_id} where u.id = ${r.created_by}`);
  if (!u) throw new HttpError(409, "sender_gone", "The person who sent this request is no longer in the workspace.");
  return { userId: u.id, email: u.email, name: u.name, orgId: r.org_id, role: u.role, sessionId: `esign:${r.id}` };
}

const appUrl = (deps: Deps) => deps.config.appUrl.replace(/\/$/, "");

/** Sends a link to every signer whose turn it is and who has none yet. A fresh token per send. */
export async function sendDueLinks(deps: Deps, r: RequestRow): Promise<number> {
  if (r.status !== "out") return 0;
  const signers = await signersOf(deps, r.id);
  let n = 0;
  for (const s of signers) {
    if (s.status !== "waiting" || !turnOf(r, signers, s)) continue;
    await sendLink(deps, r, s, false);
    n++;
  }
  return n;
}

async function sendLink(deps: Deps, r: RequestRow, s: SignerRow, reminder: boolean) {
  const auth = await senderAuth(deps, r);
  const { token, hash } = newPublicToken();
  const h = await hash;
  const now = deps.now().getTime();
  // The new token replaces any earlier one: an older email's link stops working once a reminder goes.
  await deps.db.run(reminder
    ? sql`update sign_signers set token_hash = ${h}, reminded_at = ${now} where id = ${s.id}`
    : sql`update sign_signers set token_hash = ${h}, status = 'sent', sent_at = ${now} where id = ${s.id}`);
  const url = `${appUrl(deps)}/sign/${token}`;
  const until = new Date(r.expires_at).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const text = [
    `Hi ${s.name},`, "",
    reminder ? `A reminder: ${auth.name || auth.email} asked you to sign ${r.title}.` : `${auth.name || auth.email} asked you to sign ${r.title}.`,
    ...(r.message ? ["", r.message] : []), "",
    `Open the document and sign: ${url}`, "",
    `This link is just for you and works until ${until}. You can also decline there and say why.`,
    ...(reminder ? ["Links in earlier emails about this no longer work."] : []),
  ].join("\n");
  const { sendMessage } = await import("../mail/send");
  await sendMessage(deps, auth, { mailboxId: r.mailbox_id!, to: [s.email], subject: r.subject ?? `Please sign: ${r.title}`, text, inReplyToId: r.in_reply_to_id ?? undefined });
  await addEvent(deps, r, { signerId: s.id, name: s.name, email: s.email, action: reminder ? "reminded" : "sent" });
}

// ---------------------------------------------------------------------------
// The signer's side (public)
// ---------------------------------------------------------------------------
export interface SignerView { r: RequestRow; s: SignerRow; signers: SignerRow[]; workspace: string; sender: string; state: "open" | "waiting_turn" | "signed" | "declined" | "closed" }

export async function findSigner(deps: Deps, token: string): Promise<SignerView | null> {
  if (!tokenShapeOk(token)) return null;
  const h = await tokenHash(token);
  const s = await deps.db.get<SignerRow>(sql`select * from sign_signers where token_hash = ${h}`);
  if (!s || !hashMatches(s.token_hash, h)) return null;
  const r = await deps.db.get<RequestRow & { ws: string | null; sender: string | null; tools_mode: string | null }>(sql`select q.*, o.name as ws, o.tools_mode as tools_mode, u.name as sender
    from sign_requests q left join organizations o on o.id = q.org_id left join users u on u.id = q.created_by where q.id = ${s.request_id}`);
  if (!r) return null;
  const signers = await signersOf(deps, r.id);
  const now = deps.now().getTime();
  let state: SignerView["state"] = "open";
  if (s.status === "signed") state = "signed";
  else if (s.status === "declined") state = "declined";
  else if (r.status !== "out" || r.expires_at <= now || r.tools_mode === "off") state = "closed";
  else if (!turnOf(r, signers, s)) state = "waiting_turn";
  return { r, s, signers, workspace: r.ws ?? "", sender: r.sender ?? "", state };
}

export async function markViewed(deps: Deps, v: SignerView, country: string | null) {
  if (v.state !== "open" || v.s.viewed_at) return;
  const now = deps.now().getTime();
  const res = await deps.db.run(sql`update sign_signers set viewed_at = ${now}, status = case when status = 'sent' then 'viewed' else status end where id = ${v.s.id} and viewed_at is null`);
  if (changesOf(res)) await addEvent(deps, v.r, { signerId: v.s.id, name: v.s.name, email: v.s.email, action: "viewed", ipCountry: country });
}

export function fieldsFor(v: SignerView): SignField[] {
  return (v.r.fields ? (JSON.parse(v.r.fields) as SignField[]) : []).filter((f) => f.signer === v.s.position);
}

/**
 * Signs: one picture per field of this signer (signature, initials, date). Single use: the row only moves from
 * sent or viewed to signed once. When the last signer signs, the finished copy is started.
 */
export async function signAsSigner(deps: Deps, v: SignerView, images: string[], country: string | null): Promise<{ ok: true; finished: boolean } | { ok: false; message: string }> {
  if (v.state !== "open") return { ok: false, message: "This link can no longer be used to sign." };
  const fields = fieldsFor(v);
  if (!fields.length || images.length !== fields.length) return { ok: false, message: "Add your signature to every field." };
  const pngs = images.map(pngFromDataUrl);
  if (pngs.some((p) => !p)) return { ok: false, message: "Your signature could not be read. Draw or type it again." };
  const ttl = Math.max(60, Math.ceil((v.r.expires_at - deps.now().getTime()) / 1000) + 3600);
  const ids: string[] = [];
  for (const p of pngs) ids.push(await keepFile(deps, v.r.org_id, "sign_image", p!, ttl));
  const now = deps.now().getTime();
  const res = await deps.db.run(sql`update sign_signers set status = 'signed', signed_at = ${now}, signature_file_ids = ${JSON.stringify(ids)}
    where id = ${v.s.id} and status in ('sent', 'viewed') and token_hash = ${v.s.token_hash}`);
  if (!changesOf(res)) { await dropKeptFiles(deps, v.r.org_id, ids); return { ok: false, message: "This link can no longer be used to sign." }; }
  await addEvent(deps, v.r, { signerId: v.s.id, name: v.s.name, email: v.s.email, action: "signed", ipCountry: country });
  const signers = await signersOf(deps, v.r.id);
  if (signers.every((s) => s.status === "signed")) {
    const moved = await deps.db.run(sql`update sign_requests set status = 'finishing' where id = ${v.r.id} and status = 'out'`);
    if (changesOf(moved)) await startFinish(deps, (await requestRow(deps, v.r.id))!).catch((err) => deps.log?.warn("tools.esign_finish_start_failed", { error: String(err) }));
    return { ok: true, finished: true };
  }
  await sendDueLinks(deps, (await requestRow(deps, v.r.id))!);
  return { ok: true, finished: false };
}

export async function declineAsSigner(deps: Deps, v: SignerView, reason: string, country: string | null): Promise<boolean> {
  if (v.state !== "open") return false;
  const why = reason.trim().slice(0, 500) || "No reason given";
  const now = deps.now().getTime();
  const res = await deps.db.run(sql`update sign_signers set status = 'declined', declined_at = ${now}, decline_reason = ${why}
    where id = ${v.s.id} and status in ('sent', 'viewed') and token_hash = ${v.s.token_hash}`);
  if (!changesOf(res)) return false;
  await deps.db.run(sql`update sign_requests set status = 'declined' where id = ${v.r.id} and status = 'out'`);
  await addEvent(deps, v.r, { signerId: v.s.id, name: v.s.name, email: v.s.email, action: "declined", ipCountry: country, detail: why });
  const u = await deps.db.get<{ email: string }>(sql`select email from users where id = ${v.r.created_by}`);
  if (u) {
    await sendSystemEmail(deps, { to: u.email, orgId: v.r.org_id, subject: `${v.s.name} declined to sign ${v.r.title}`,
      text: `${v.s.name} (${v.s.email}) declined to sign ${v.r.title}. Their reason: ${why}\n\nThe request is closed, and no one else can sign it.`,
      action: { label: "See the request", url: `${appUrl(deps)}/app/tools/sign?request=${v.r.id}` } }).catch(() => undefined);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Finishing: the engine sign op with the signing record
// ---------------------------------------------------------------------------
/** What the engine's audit option gets: the D1 events, word for word. */
export function auditFor(r: RequestRow, events: EventRow[]) {
  return {
    title: r.title,
    document_sha256: r.source_sha256,
    events: events.map((e) => ({ at: new Date(e.at).toISOString(), who: e.name, email: e.email, what: actionText(e.action), ip_country: e.ip_country ?? "" })),
  };
}

export async function startFinish(deps: Deps, r: RequestRow): Promise<void> {
  if (r.status !== "finishing" || r.engine_job) return;
  const signers = await signersOf(deps, r.id);
  const fields = r.fields ? (JSON.parse(r.fields) as SignField[]) : [];
  const src = await readKeptFile(deps, r.source_file_id);
  if (!src) { await failRequest(deps, r, "The document expired before everyone signed."); return; }
  const files: EngineFile[] = [{ name: "document.pdf", type: "application/pdf", bytes: src }];
  const sigs: Record<string, unknown>[] = [];
  for (const s of signers) {
    const ids = s.signature_file_ids ? (JSON.parse(s.signature_file_ids) as string[]) : [];
    const mine = fields.filter((f) => f.signer === s.position);
    for (let i = 0; i < mine.length; i++) {
      const png = ids[i] ? await readKeptFile(deps, ids[i]) : null;
      if (!png) { await failRequest(deps, r, `The signature of ${s.name} expired.`); return; }
      const f = mine[i];
      sigs.push({ page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, image: files.length - 1, kind: f.kind, name: s.name, signed_at: iso(s.signed_at), date: String(iso(s.signed_at) ?? "").slice(0, 10) });
      files.push({ name: `sig-${files.length}.png`, type: "image/png", bytes: png, field: SIGN_IMAGES_FIELD });
    }
  }
  const events = await eventsOf(deps, r.id);
  const job = await submitEngineJob(deps, r.org_id, r.created_by, "sign", files, { signatures: JSON.stringify(sigs), audit: JSON.stringify(auditFor(r, events)) });
  await deps.db.run(sql`update sign_requests set engine_job = ${job}, engine_kind = 'sign' where id = ${r.id} and status = 'finishing'`);
}

async function failRequest(deps: Deps, r: RequestRow, why: string) {
  await deps.db.run(sql`update sign_requests set status = 'failed', error = ${why}, engine_job = null where id = ${r.id}`);
}

/** Moves a finishing request on: checks the engine job, keeps the PDF, sends it to everyone. Safe to call often. */
export async function advance(deps: Deps, r: RequestRow): Promise<RequestRow> {
  if (r.status !== "finishing") return r;
  if (!r.engine_job) { await startFinish(deps, r); return (await requestRow(deps, r.id))!; }
  const st = await engineJobState(deps, r.org_id, r.created_by, r.engine_job);
  if (st.status === "queued" || st.status === "running") return r;
  if (st.status !== "done") {
    // A lost job (engine restart) is started again once; a failed one stops with the engine's words.
    if (st.status === "expired") { await deps.db.run(sql`update sign_requests set engine_job = null where id = ${r.id}`); return (await requestRow(deps, r.id))!; }
    await failRequest(deps, r, st.error || "The finished copy could not be made.");
    return (await requestRow(deps, r.id))!;
  }
  const out = await engineJobOutput(deps, r.org_id, r.created_by, r.engine_job);
  if (!out) { await deps.db.run(sql`update sign_requests set engine_job = null where id = ${r.id}`); return (await requestRow(deps, r.id))!; }
  const fact = typeof st.result?.sha256 === "string" && /^[a-f0-9]{64}$/.test(st.result.sha256) ? st.result.sha256 : await sha256HexBytes(out.slice().buffer as ArrayBuffer);
  const ttl = Math.max(3600, Math.ceil((r.expires_at - deps.now().getTime()) / 1000));
  const finalId = await keepFile(deps, r.org_id, "sign_final", out, ttl, { name: r.title });
  const now = deps.now().getTime();
  const done = await deps.db.run(sql`update sign_requests set status = 'completed', final_file_id = ${finalId}, final_sha256 = ${fact}, completed_at = ${now}, engine_job = null, engine_kind = null
    where id = ${r.id} and status = 'finishing'`);
  if (!changesOf(done)) { await dropKeptFiles(deps, r.org_id, [finalId]); return (await requestRow(deps, r.id))!; }
  const fresh = (await requestRow(deps, r.id))!;
  if (r.kind === "request") {
    await addEvent(deps, r, { name: "Multies", email: "", action: "completed", detail: `Finished copy SHA-256 ${fact}` });
    await sendFinished(deps, fresh, out).catch(async (err) => {
      deps.log?.warn("tools.esign_send_finished_failed", { error: String(err) });
      await deps.db.run(sql`update sign_requests set error = ${"The signed copy could not be emailed: " + (err instanceof Error ? err.message : "unknown error")} where id = ${r.id}`);
    });
  }
  return fresh;
}

export const signedName = (title: string) => `${title.replace(/\.pdf$/i, "")} (signed).pdf`;

async function sendFinished(deps: Deps, r: RequestRow, pdf: Uint8Array) {
  const auth = await senderAuth(deps, r);
  const signers = await signersOf(deps, r.id);
  const text = [
    "Hi everyone,", "",
    `Everyone has signed ${r.title}. The signed copy, with its signing record on the last page, is attached.`, "",
    `Fingerprint of the document before signing (SHA-256): ${r.source_sha256}`,
    `Fingerprint of the signed copy (SHA-256): ${r.final_sha256}`,
  ].join("\n");
  const { sendMessage } = await import("../mail/send");
  await sendMessage(deps, auth, { mailboxId: r.mailbox_id!, to: signers.map((s) => s.email), subject: r.subject && !r.subject.startsWith("Please sign:") ? r.subject : `Signed: ${r.title}`, text, inReplyToId: r.in_reply_to_id ?? undefined },
    { attachments: [{ filename: signedName(r.title), contentType: "application/pdf", content: pdf }] });
}

// ---------------------------------------------------------------------------
// The sender's list, detail, cancel, download
// ---------------------------------------------------------------------------
export async function listRequests(deps: Deps, auth: AuthContext): Promise<SignRequestInfo[]> {
  const mine = auth.role === "member";
  const rows = await deps.db.all<RequestRow>(sql`select * from sign_requests where org_id = ${auth.orgId} and status != 'draft' ${mine ? sql`and created_by = ${auth.userId}` : sql``} order by created_at desc limit 100`);
  if (!rows.length) return [];
  const all = await deps.db.all<SignerRow>(sql`select * from sign_signers where org_id = ${auth.orgId} and request_id in (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)}) order by position`);
  const now = deps.now().getTime();
  return rows.map((r) => info(liveStatus(r, now), all.filter((s) => s.request_id === r.id)));
}

const liveStatus = (r: RequestRow, now: number): RequestRow => (r.expires_at <= now && (r.status === "out" || r.status === "draft") ? { ...r, status: "expired" } : r);

export async function requestDetail(deps: Deps, auth: AuthContext, id: string): Promise<SignRequestInfo> {
  let r = await ownRequest(deps, auth, id);
  if (r.status === "finishing") r = await advance(deps, r).catch(() => r);
  return info(liveStatus(r, deps.now().getTime()), await signersOf(deps, r.id), await eventsOf(deps, r.id));
}

export async function cancelRequest(deps: Deps, auth: AuthContext, id: string, ip?: string): Promise<SignRequestInfo> {
  const r = await ownRequest(deps, auth, id);
  if (!["out", "draft", "finishing", "failed"].includes(r.status)) throw badRequest("This request is already closed.");
  await deps.db.run(sql`update sign_requests set status = 'cancelled', engine_job = null where id = ${r.id}`);
  await deps.db.run(sql`update sign_signers set token_hash = null where request_id = ${r.id} and status != 'signed'`);
  await addEvent(deps, r, { name: auth.name || auth.email, email: auth.email, action: "cancelled" });
  await dropRequestFiles(deps, r);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_cancelled", targetType: "sign_request", targetId: r.id, ip });
  return requestDetail(deps, auth, r.id);
}

async function dropRequestFiles(deps: Deps, r: RequestRow) {
  const signers = await signersOf(deps, r.id);
  const pages = r.pages ? (JSON.parse(r.pages) as PagesInfo) : null;
  await dropKeptFiles(deps, r.org_id, [r.source_file_id, pages?.zip, ...signers.flatMap((s) => (s.signature_file_ids ? (JSON.parse(s.signature_file_ids) as string[]) : []))]);
}

export async function requestFile(deps: Deps, auth: AuthContext, id: string): Promise<{ bytes: Uint8Array; name: string }> {
  const r = await ownRequest(deps, auth, id);
  if (r.status !== "completed" || !r.final_file_id) throw notFound("Signed copy");
  const bytes = await readKeptFile(deps, r.final_file_id);
  if (!bytes) throw new HttpError(404, "not_found", "The signed copy here has expired. It is still in the email thread.");
  return { bytes, name: signedName(r.title) };
}

// ---------------------------------------------------------------------------
// Cron pass (the lead calls runSignPass from the scheduled handler)
// ---------------------------------------------------------------------------
/**
 * One pass: expire overdue requests, move finishing ones on, send reminders, prune old file rows.
 * Cost per pass: at most 4 small reads with nothing to do (each on an index), plus a few rows of writes per
 * request it acts on; it acts on at most 5 finishing requests and 20 reminders a pass.
 */
export async function runSignPass(deps: Deps): Promise<{ expired: number; finished: number; reminded: number }> {
  const now = deps.now().getTime();
  const out = { expired: 0, finished: 0, reminded: 0 };
  const overdue = await deps.db.all<RequestRow>(sql`select * from sign_requests where status in ('out', 'draft', 'finishing') and expires_at <= ${now} limit 20`);
  for (const r of overdue) {
    await deps.db.run(sql`update sign_requests set status = 'expired' where id = ${r.id}`);
    await deps.db.run(sql`update sign_signers set token_hash = null where request_id = ${r.id} and status != 'signed'`);
    await dropRequestFiles(deps, r).catch(() => undefined);
    out.expired++;
  }
  const finishing = await deps.db.all<RequestRow>(sql`select * from sign_requests where status = 'finishing' and expires_at > ${now} limit 5`);
  for (const r of finishing) {
    const after = await advance(deps, r).catch((err) => { deps.log?.warn("tools.esign_advance_failed", { error: String(err) }); return r; });
    if (after.status === "completed") out.finished++;
  }
  const due = await deps.db.all<SignerRow & { remind_days: number }>(sql`select s.*, q.remind_days as remind_days from sign_signers s join sign_requests q on q.id = s.request_id
    where q.status = 'out' and q.remind_days > 0 and q.expires_at > ${now} and s.status in ('sent', 'viewed')
      and coalesce(s.reminded_at, s.sent_at) <= ${now} - q.remind_days * 86400000 limit 20`);
  for (const s of due) {
    const r = await requestRow(deps, s.request_id);
    if (!r) continue;
    const signers = await signersOf(deps, r.id);
    if (!turnOf(r, signers, s)) continue;
    await sendLink(deps, r, s, true).then(() => { out.reminded++; }, (err) => deps.log?.warn("tools.esign_remind_failed", { error: String(err) }));
  }
  const { pruneKeptFiles } = await import("./kept-files");
  await pruneKeptFiles(deps);
  return out;
}
