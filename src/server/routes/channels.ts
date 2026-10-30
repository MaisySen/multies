/**
 * C1: chat channels. /api/channels (session, the web app) and /api/webhooks/meta (public, Meta signed).
 * The services load on first use, so these routes add nothing to a cold start.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { idempotency, idempotentId, idempotentRetry, sessionIdempotencyScope } from "../lib/idempotency";
import { HttpError } from "../lib/errors";

const svc = () => import("../services/channels/service");

// Built once per isolate (zod schema construction is real CPU on a warm request).
const SettingsBody = z.object({ enabled: z.boolean() });
const ConnectBody = z.object({ provider: z.literal("whatsapp"), code: z.string().min(1).max(2048), wabaId: z.string().regex(/^\d{1,32}$/), phoneNumberId: z.string().regex(/^\d{1,32}$/), coexistence: z.boolean().optional() });
const MockConnectBody = z.object({ name: z.string().max(80).optional() });
const ListQuery = z.object({
  channel: z.string().max(64).optional(), status: z.enum(["open", "waiting", "done"]).optional(),
  assignee: z.string().max(64).optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
});
const PatchBody = z.object({ assigneeUserId: z.string().max(64).nullable().optional(), status: z.enum(["open", "waiting", "done"]).optional(), labels: z.array(z.string().max(40)).max(20).optional() });
const SendBody = z.object({
  text: z.string().max(4096).optional(),
  // 5 MB of file is about 6.7 MB of base64.
  file: z.object({ name: z.string().min(1).max(255), contentType: z.string().min(1).max(128), dataB64: z.string().min(1).max(7_000_000) }).optional(),
});
const TemplateBody = z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(15), params: z.array(z.string().max(1024)).max(20) });
const NoteBody = z.object({ body: z.string().min(1).max(4000) });
const MockInbound = z.object({ channelId: z.string().max(64), from: z.string().regex(/^\d{6,20}$/), name: z.string().max(100).optional(), text: z.string().max(4096).optional(), image: z.boolean().optional() });
const MockAge = z.object({ conversationId: z.string().max(64), hours: z.number().min(0).max(24 * 30) });

async function runLater(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }, work: Promise<unknown>) {
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try { const ctx = c.executionCtx; waitUntil = ctx.waitUntil.bind(ctx); } catch { waitUntil = undefined; }
  if (waitUntil) waitUntil(work); else await work;
}

export function channelRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", idempotency(sessionIdempotencyScope))
    .get("/status", async (c) => c.json(await (await svc()).channelsStatus(c.var.deps, c.var.auth)))
    .put("/settings", async (c) => c.json(await (await svc()).setEnabled(c.var.deps, c.var.auth, (await parseBody(c, SettingsBody)).enabled)))
    .post("/connect", async (c) => c.json({ channel: await (await svc()).connectWhatsApp(c.var.deps, c.var.auth, await parseBody(c, ConnectBody)) }, 201))
    .post("/connect-mock", async (c) => c.json({ channel: await (await svc()).connectMock(c.var.deps, c.var.auth, (await parseBody(c, MockConnectBody)).name) }, 201))
    .post("/:channelId/disconnect", async (c) => c.json({ channel: await (await svc()).disconnectChannel(c.var.deps, c.var.auth, c.req.param("channelId")) }))
    .get("/conversations", async (c) => c.json({ data: await (await svc()).listConversations(c.var.deps, c.var.auth, parseQuery(c, ListQuery)) }))
    .get("/conversations/:id", async (c) => c.json(await (await svc()).conversationDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/conversations/:id", async (c) => c.json({ conversation: await (await svc()).patchConversation(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PatchBody)) }))
    .post("/conversations/:id/read", async (c) => c.json(await (await svc()).markRead(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/conversations/:id/messages", async (c) => {
      const b = await parseBody(c, SendBody);
      const message = await (await svc()).sendMessage(c.var.deps, c.var.auth, c.req.param("id"), b, { id: await idempotentId(c.req.raw, "cm"), retry: idempotentRetry(c.req.raw) });
      return c.json({ message }, 201);
    })
    .get("/conversations/:id/templates", async (c) => c.json({ templates: await (await svc()).listTemplates(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/conversations/:id/template", async (c) => {
      const b = await parseBody(c, TemplateBody);
      const message = await (await svc()).sendTemplate(c.var.deps, c.var.auth, c.req.param("id"), b, { id: await idempotentId(c.req.raw, "cm"), retry: idempotentRetry(c.req.raw) });
      return c.json({ message }, 201);
    })
    .get("/conversations/:id/notes", async (c) => c.json(await (await svc()).listNotes(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/conversations/:id/notes", async (c) => c.json({ note: await (await svc()).addNote(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, NoteBody)).body) }, 201))
    .post("/messages/:id/task", async (c) => c.json({ task: await (await svc()).taskFromMessage(c.var.deps, c.var.auth, c.req.param("id"), { id: await idempotentId(c.req.raw, "tsk"), retry: idempotentRetry(c.req.raw) }) }, 201))
    .get("/media/:id", async (c) => {
      const f = await (await svc()).mediaOf(c.var.deps, c.var.auth, c.req.param("id"));
      // Served as an attachment unless it is a plain image, so a customer's file never runs as a page here.
      const inline = /^image\/(png|jpeg|gif|webp)$/.test(f.contentType);
      return new Response(f.bytes as BodyInit, { headers: {
        "content-type": inline ? f.contentType : "application/octet-stream",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff",
      } });
    })
    // Local test provider only (CHANNELS_MOCK; refused in production by config).
    .post("/mock/inbound", async (c) => {
      const s = await svc();
      const b = await parseBody(c, MockInbound);
      const ch = await s.mockChannel(c.var.deps, c.var.auth, b.channelId);
      const { mockInboundPayload } = await import("../services/channels/mock");
      const p = await mockInboundPayload({ endpointId: ch.externalId, from: b.from, name: b.name, text: b.text, image: b.image });
      const { handleWebhookPost } = await import("../services/channels/receive");
      const r = await handleWebhookPost(c.var.deps, p.body, p.signature);
      if (r.status !== 200) throw new HttpError(r.status, "mock_refused", "The test message was refused.");
      await r.work;
      return c.json({ ok: true });
    })
    .post("/mock/age", async (c) => {
      const b = await parseBody(c, MockAge);
      return c.json(await (await svc()).mockAge(c.var.deps, c.var.auth, b.conversationId, b.hours));
    });
}

/** Meta's webhook: GET is the subscribe handshake, POST the deliveries. No session; the signature is the auth. */
const WEBHOOK_MAX_BYTES = 3 * 1024 * 1024;

export function metaWebhookRoutes() {
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const { verifyChallenge } = await import("../services/channels/webhook");
      const ok = verifyChallenge({ mode: c.req.query("hub.mode"), token: c.req.query("hub.verify_token"), challenge: c.req.query("hub.challenge") }, c.var.deps.config.channels.meta?.verifyToken);
      return ok ? c.text(ok, 200) : c.text("Forbidden", 403);
    })
    .post("/", async (c) => {
      // Meta's deliveries can carry up to 1,000 updates and 3 MB.
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > WEBHOOK_MAX_BYTES) return c.text("Too large", 413);
      const raw = await c.req.text();
      if (raw.length > WEBHOOK_MAX_BYTES) return c.text("Too large", 413);
      const { handleWebhookPost } = await import("../services/channels/receive");
      const r = await handleWebhookPost(c.var.deps, raw, c.req.header("x-hub-signature-256"));
      // Messages are stored before this answer; only file downloads run after it on Workers. A 500 makes Meta retry.
      if (r.work) await runLater(c, r.work);
      if (r.status === 500) return c.text("Try again", 500);
      return c.text(r.status === 200 ? "EVENT_RECEIVED" : "Forbidden", r.status);
    });
}
