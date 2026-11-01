/**
 * R112 Anonymous reporting channel and data requests (REPORTING_R112).
 *
 * Public, no session (mounted at /api/pub/report and /api/pub/data-request). These routes never read the session cookie, never set
 * one, never read the client address or user agent, are skipped by the address based limiter and write no access log line.
 *   GET  /api/pub/report/:pid                  the channel's page (workspace name, intro, limits)
 *   POST /api/pub/report/:pid/cases            a new report (JSON, or multipart with a "data" JSON part and "files") -> case number + passphrase, once
 *   POST /api/pub/report/:pid/login            { caseNo, passphrase } -> a 30 minute reader token and the thread
 *   POST /api/pub/report/:pid/thread           { caseNo, token }
 *   POST /api/pub/report/:pid/reply            { caseNo, token, text } (+ files)
 *   POST /api/pub/report/:pid/file             { caseNo, token, fileId } -> the file
 *   GET  /api/pub/data-request/:pid            the request page
 *   POST /api/pub/data-request/:pid            { email, type } -> always { ok }, a one time link goes to the email
 *   POST /api/pub/data-request/verify          { token }
 *   POST /api/pub/data-request/download        { token } -> the ZIP
 * Workspace session (owners and admins; a member only for cases they handle):
 *   /api/reporting/access | channel | handlers | cases | cases/:id | cases/:id/messages | cases/:id/files/:fileId
 *   /api/data-requests settings | list | create | log | :id | :id/export | :id/send-link | :id/delete | :id/cancel | :id/resend
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import * as A from "../services/suite/reporting-r112";
import * as B from "../services/suite/data-requests-r112";
import { DATA_KINDS, DATA_REQUEST_TYPES, REPORT_STATUSES, randomPreview } from "@/shared/reporting-r112";

const Pid = z.string().min(8).max(40);
const NewReport = z.object({ what: z.string().max(25_000), when: z.string().max(500).optional(), where: z.string().max(500).optional(), who: z.string().max(2000).optional(), website: z.string().max(200).optional() }).strict();
const Reader = z.object({ caseNo: z.string().max(40), token: z.string().max(200) }).strict();
const Reply = Reader.extend({ text: z.string().max(12_000) }).strict();
const NewRequest = z.object({ email: z.string().max(320), type: z.enum(DATA_REQUEST_TYPES), website: z.string().max(200).optional() }).strict();

const PRIVATE = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;
const noStore = (c: Context<AppEnv>) => { for (const [k, v] of Object.entries(PRIVATE)) c.header(k, v); };

/** Reads a JSON body, or a multipart body with a "data" JSON part and any number of "files" parts. */
async function readWithFiles<T extends z.ZodTypeAny>(c: Context<AppEnv>, schema: T): Promise<{ body: z.infer<T>; files: A.UploadFile[] }> {
  const type = c.req.header("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) return { body: (await parseBody(c, schema)) as z.infer<T>, files: [] };
  const form = await c.req.parseBody({ all: true });
  let raw: unknown;
  try { raw = JSON.parse(typeof form.data === "string" ? form.data : "{}"); } catch { throw new HttpError(422, "validation_failed", "The form could not be read."); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(422, "validation_failed", "Some fields are not valid.");
  const list = form.files === undefined ? [] : Array.isArray(form.files) ? form.files : [form.files];
  const files: A.UploadFile[] = [];
  for (const f of list) {
    if (typeof f === "string") continue;
    files.push({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return { body: parsed.data, files };
}

function fileResponse(f: { name: string; size: number; stream: ReadableStream<Uint8Array> }) {
  return new Response(f.stream, { headers: {
    "content-type": "application/octet-stream", "content-length": String(f.size), "x-content-type-options": "nosniff", ...PRIVATE,
    "content-disposition": `attachment; filename="${f.name.replace(/["\\\r\n]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
  } });
}
function zipResponse(z: { zip: Uint8Array; name: string }) {
  return new Response(z.zip as unknown as BodyInit, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${z.name}"`, "x-content-type-options": "nosniff", ...PRIVATE } });
}

export function reportPublicRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!A.reportingOn(c.var.deps)) throw notFound("Page"); await next(); noStore(c); c.res.headers.delete("set-cookie"); })
    .get("/:pid", async (c) => c.json(await A.publicChannel(c.var.deps, Pid.parse(c.req.param("pid")))))
    .post("/:pid/cases", async (c) => {
      const pid = Pid.parse(c.req.param("pid"));
      const { body, files } = await readWithFiles(c, NewReport);
      // The hidden trap field: a person never fills it. The answer looks the same, and nothing is kept.
      if (body.website) return c.json(randomPreview());
      return c.json(await A.submitReport(c.var.deps, pid, body, files));
    })
    .post("/:pid/login", async (c) => {
      const b = await parseBody(c, z.object({ caseNo: z.string().max(40), passphrase: z.string().max(200) }).strict());
      return c.json(await A.reporterLogin(c.var.deps, Pid.parse(c.req.param("pid")), b.caseNo, b.passphrase));
    })
    .post("/:pid/thread", async (c) => { const b = await parseBody(c, Reader); return c.json(await A.reporterThread(c.var.deps, Pid.parse(c.req.param("pid")), b.caseNo, b.token)); })
    .post("/:pid/reply", async (c) => {
      const { body, files } = await readWithFiles(c, Reply);
      return c.json(await A.reporterReply(c.var.deps, Pid.parse(c.req.param("pid")), body.caseNo, body.token, body.text, files));
    })
    .post("/:pid/file", async (c) => {
      const b = await parseBody(c, Reader.extend({ fileId: z.string().max(80) }).strict());
      return fileResponse(await A.reporterFile(c.var.deps, Pid.parse(c.req.param("pid")), b.caseNo, b.token, b.fileId));
    });
}

export function dataRequestPublicRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!A.reportingOn(c.var.deps)) throw notFound("Page"); await next(); noStore(c); })
    .post("/verify", async (c) => c.json(await B.verifyRequest(c.var.deps, (await parseBody(c, z.object({ token: z.string().max(100) }).strict())).token)))
    .post("/download", async (c) => zipResponse(await B.publicDownload(c.var.deps, (await parseBody(c, z.object({ token: z.string().max(100) }).strict())).token)))
    .get("/:pid", async (c) => c.json(await B.publicRequestPage(c.var.deps, Pid.parse(c.req.param("pid")))))
    .post("/:pid", async (c) => {
      const b = await parseBody(c, NewRequest);
      if (b.website) return c.json({ ok: true });
      return c.json(await B.publicCreate(c.var.deps, Pid.parse(c.req.param("pid")), { email: b.email, type: b.type }));
    });
}

const actor = (c: Context<AppEnv>) => c.var.auth;
const CaseView = z.enum(["open", "new", "closed", "mine", "all"]);

export function reportingRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { if (!A.reportingOn(c.var.deps)) throw notFound("Page"); await next(); noStore(c); })
    .get("/access", async (c) => c.json(await A.access(c.var.deps, actor(c))))
    .get("/channel", async (c) => {
      if (!A.isAdmin(actor(c))) throw new HttpError(403, "forbidden", "Only owners and admins can see the reporting channel settings.");
      return c.json({ channel: await A.getChannel(c.var.deps, actor(c)) });
    })
    .put("/channel", async (c) => c.json({ channel: await A.setChannel(c.var.deps, actor(c), await parseBody(c, z.object({
      enabled: z.boolean().optional(), intro: z.string().max(2000).optional(), defaultHandlerId: z.string().max(80).nullable().optional(),
    }).strict())) }))
    .get("/handlers", async (c) => c.json({ handlers: await A.handlerChoices(c.var.deps, actor(c)) }))
    .get("/cases", async (c) => c.json(await A.listCases(c.var.deps, actor(c), CaseView.catch("open").parse(c.req.query("view") ?? "open"))))
    .get("/cases/:id", async (c) => c.json({ case: await A.getCase(c.var.deps, actor(c), c.req.param("id")) }))
    .post("/cases/:id/messages", async (c) => {
      const { body, files } = await readWithFiles(c, z.object({ text: z.string().max(12_000), internal: z.boolean().optional() }).strict());
      return c.json({ case: await A.handlerReply(c.var.deps, actor(c), c.req.param("id"), body, files) });
    })
    .patch("/cases/:id", async (c) => c.json({ case: await A.updateCase(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, z.object({
      status: z.enum(REPORT_STATUSES).optional(), handlerId: z.string().max(80).nullable().optional(), outcome: z.string().max(4000).optional(),
    }).strict())) }))
    .get("/cases/:id/files/:fileId", async (c) => fileResponse(await A.handlerFile(c.var.deps, actor(c), c.req.param("id"), c.req.param("fileId"))));
}

export function dataRequestRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { if (!A.reportingOn(c.var.deps)) throw notFound("Page"); await next(); noStore(c); })
    .get("/settings", async (c) => c.json(await B.settings(c.var.deps, actor(c))))
    .put("/settings", async (c) => c.json(await B.setSettings(c.var.deps, actor(c), await parseBody(c, z.object({ publicEnabled: z.boolean() }).strict()))))
    .get("/log", async (c) => c.json(await B.workspaceLog(c.var.deps, actor(c))))
    .get("/", async (c) => c.json(await B.listRequests(c.var.deps, actor(c))))
    .post("/", async (c) => c.json(await B.adminCreate(c.var.deps, actor(c), await parseBody(c, z.object({ email: z.string().max(320), type: z.enum(DATA_REQUEST_TYPES) }).strict()))))
    .get("/:id", async (c) => c.json(await B.getRequest(c.var.deps, actor(c), c.req.param("id"))))
    .get("/:id/export", async (c) => zipResponse(await B.exportZip(c.var.deps, actor(c), c.req.param("id"))))
    .post("/:id/send-link", async (c) => c.json(await B.sendDownloadLink(c.var.deps, actor(c), c.req.param("id"))))
    .post("/:id/delete", async (c) => c.json(await B.deleteData(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, z.object({
      confirm: z.string().max(20), kinds: z.array(z.enum(DATA_KINDS)).max(3).optional(),
    }).strict()))))
    .post("/:id/cancel", async (c) => c.json(await B.cancelRequest(c.var.deps, actor(c), c.req.param("id"))))
    .post("/:id/resend", async (c) => c.json(await B.resendVerify(c.var.deps, actor(c), c.req.param("id"))));
}
