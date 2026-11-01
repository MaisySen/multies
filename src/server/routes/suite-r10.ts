/**
 * Round 10 in the app (cookie session): team chat, templates and goals, plus the guest's view of
 * chat. Built on the first request that needs it (see app.ts), so a new Worker isolate's first
 * call stays light. The same services back the REST API (v1-suite-r10.ts) and MCP.
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { fromB64 } from "../lib/crypto";
import {
  addMembers, channelMessages, chatPeople, createChannel, deleteMessage, editMessage, getChannel, getMessage, getThread, guestChannels, guestMessages, guestPost, guestThread,
  joinChannel, leaveChannel, listChannels, listPins, markRead, pinMessage, messageToTask, openDm, postMessageAcked, readChatFile, readSignedChatFile, unreadSummary, updateChannel, type GuestViewer,
} from "../services/suite/chat";
import { ackFor } from "../services/suite/chat-ack-r33";
import { deleteTemplate, getTemplate, listTemplates, saveTemplate, useTemplate } from "../services/suite/templates";
import { addKeyResult, createGoal, deleteGoal, deleteKeyResult, getGoal, goalTree, updateGoal, updateKeyResult } from "../services/suite/goals";
import { GUEST_COOKIE, resolveGuest } from "../services/suite/guests";
import { parseAssignee } from "../services/suite/tasks";
import { chatR20Routes, guestChatR20Routes } from "./chat-r20";
import { chatR23CallRoutes, guestChatR23CallRoutes } from "./chat-r23-calls";
import { chatLiveR32Routes } from "./chat-live-r32";
import { withBlockedByMe } from "../services/suite/reports-r35"; // R35

export const ChatAttachment = z.object({ filename: z.string().trim().min(1).max(200), contentType: z.string().max(100).optional(), contentBase64: z.string().min(1).max(14_000_000) });
export const ChatPost = z.object({ body: z.string().max(20_000).default(""), parentId: z.string().max(64).nullable().optional(), topicId: z.string().max(64).nullable().optional() /* R96 */, attachments: z.array(ChatAttachment).max(5).optional(), /** R33: the sender's id for this send; a repeat with the same id returns the first message (see chat-ack-r33.ts). */ clientMsgId: z.string().regex(/^[0-9a-z]{17,49}$/).optional() });
export const ChannelCreate = z.object({ name: z.string().trim().min(1).max(80), topic: z.string().max(250).optional(), private: z.boolean().optional(), memberIds: z.array(z.string().max(80)).max(200).optional(), projectId: z.string().max(64).nullable().optional(), guestAccess: z.boolean().optional() });
export const ChannelPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), topic: z.string().max(250).optional(), archived: z.boolean().optional(), guestAccess: z.boolean().optional(), projectId: z.string().max(64).nullable().optional() });
export const MessageToTask = z.object({ title: z.string().max(300).optional(), projectId: z.string().max(64).optional(), assignee: z.string().regex(/^(member|agent):[A-Za-z0-9_-]+$/).nullable().optional(), due: z.string().max(40).nullable().optional(), triage: z.boolean().optional() });
export const MessagesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().max(64).optional(), since: z.string().max(40).optional(), topicId: z.string().max(64).optional() /* R96 */ });
const KrKind = z.enum(["number", "currency", "percent", "tasks"]);
export const KrCreate = z.object({ name: z.string().trim().min(1).max(200), kind: KrKind.optional(), start: z.number().finite().optional(), target: z.number().finite().optional(), current: z.number().finite().optional(), unit: z.string().max(20).optional(), projectId: z.string().max(64).nullable().optional(), taskIds: z.array(z.string().max(64)).max(500).optional() });
export const KrPatch = KrCreate.partial().omit({ kind: true });
const Health = z.enum(["on_track", "at_risk", "off_track"]).nullable().optional();
export const GoalCreate = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(5000).optional(), ownerId: z.string().max(64).nullable().optional(), parentId: z.string().max(64).nullable().optional(), start: z.string().max(40).nullable().optional(), due: z.string().max(40).nullable().optional(), health: Health, keyResults: z.array(KrCreate).max(20).optional() });
export const GoalPatch = GoalCreate.partial().omit({ keyResults: true }).extend({ archived: z.boolean().optional() });
export const TemplateSave = z.object({ kind: z.enum(["project", "task", "doc"]), fromProjectId: z.string().max(64).optional(), fromTaskId: z.string().max(64).optional(), fromDocId: z.string().max(64).optional(),
  /** From scratch: { project: { name, description?, color? }, tasks: [...] }, a task { title, notes?, subtasks?, ... } or a doc { title, text }. */
  data: z.record(z.string(), z.unknown()).optional(), name: z.string().max(120).optional(), description: z.string().max(500).optional(), category: z.string().max(40).optional() });
export const TemplateUse = z.object({ name: z.string().max(120).optional(), projectId: z.string().max(64).optional(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

export function decodeAttachments(list: z.infer<typeof ChatAttachment>[] | undefined) {
  return (list ?? []).map((f) => {
    try { return { name: f.filename, type: f.contentType ?? "application/octet-stream", bytes: fromB64(f.contentBase64) }; }
    catch { throw new HttpError(422, "validation_failed", "Attachment content must be base64."); }
  });
}

/** Sends a stored file as a download, never rendered inline. */
export function download(f: { filename: string; contentType: string; bytes: Uint8Array }) {
  return new Response(f.bytes as BodyInit, {
    headers: {
      "content-type": f.contentType, "content-length": String(f.bytes.length),
      "content-disposition": `attachment; filename="${f.filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

export function chatRoutes() {
  return new Hono<AppEnv>()
    // A signed, short-lived file link (see signedFileUrl) needs no session.
    .get("/files/:id/download", async (c) => download(await readSignedChatFile(c.var.deps, c.req.param("id"), c.req.query("exp"), c.req.query("sig"))))
    .use("*", requireAuth)
    .get("/channels", async (c) => c.json({ channels: await listChannels(c.var.deps, c.var.auth, { includeArchived: c.req.query("archived") === "1" }) }))
    .post("/channels", async (c) => c.json({ channel: await createChannel(c.var.deps, c.var.auth, await parseBody(c, ChannelCreate)) }, 201))
    .post("/dms", async (c) => {
      const r = await openDm(c.var.deps, c.var.auth, (await parseBody(c, z.object({ userIds: z.array(z.string().max(80)).min(1).max(8) }))).userIds);
      return c.json({ channel: r.channel }, r.created ? 201 : 200);
    })
    .get("/channels/:id", async (c) => c.json({ channel: await getChannel(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/channels/:id", async (c) => c.json({ channel: await updateChannel(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ChannelPatch)) }))
    .post("/channels/:id/join", async (c) => c.json({ channel: await joinChannel(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/channels/:id/leave", async (c) => c.json(await leaveChannel(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/channels/:id/members", async (c) => c.json({ channel: await addMembers(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ userIds: z.array(z.string().max(80)).min(1).max(200) }))).userIds) }))
    .get("/channels/:id/messages", async (c) => c.json(await channelMessages(c.var.deps, c.var.auth, c.req.param("id"), parseQuery(c, MessagesQuery))))
    .post("/channels/:id/messages", async (c) => {
      const b = await parseBody(c, ChatPost);
      // R33: the answer carries an ack naming the client id, and a repeat answers 200 with the first message.
      const r = await postMessageAcked(c.var.deps, c.var.auth, c.req.param("id"), { body: b.body, parentId: b.parentId, files: decodeAttachments(b.attachments), clientMsgId: b.clientMsgId, topicId: b.topicId });
      return c.json({ message: r.message, ...(b.clientMsgId ? { ack: ackFor(b.clientMsgId, r.message, r.deduped) } : {}) }, r.deduped ? 200 : 201);
    })
    .post("/channels/:id/read", async (c) => c.json(await markRead(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ messageId: z.string().max(64).optional() }).default({}))).messageId)))
    .get("/unread", async (c) => c.json(await unreadSummary(c.var.deps, c.var.auth)))
    // R35: each person carries blockedByMe so clients can show Unblock.
    .get("/people", async (c) => c.json({ people: await withBlockedByMe(c.var.deps, c.var.auth.userId, await chatPeople(c.var.deps, c.var.auth.orgId)) }))
    .get("/messages/:id", async (c) => c.json(await getMessage(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/messages/:id/thread", async (c) => c.json(await getThread(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/messages/:id", async (c) => c.json({ message: await editMessage(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ body: z.string().min(1).max(20_000) }))).body) }))
    .delete("/messages/:id", async (c) => c.json(await deleteMessage(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/messages/:id/pin", async (c) => c.json({ message: await pinMessage(c.var.deps, c.var.auth, c.req.param("id"), true) }))
    .delete("/messages/:id/pin", async (c) => c.json({ message: await pinMessage(c.var.deps, c.var.auth, c.req.param("id"), false) }))
    .get("/channels/:id/pins", async (c) => c.json(await listPins(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/messages/:id/task", async (c) => {
      const b = await parseBody(c, MessageToTask.default({}));
      return c.json({ task: await messageToTask(c.var.deps, c.var.auth, c.req.param("id"), { title: b.title, projectId: b.projectId, assignee: parseAssignee(b.assignee), due: b.due, triage: b.triage }) }, 201);
    })
    .get("/files/:id", async (c) => download(await readChatFile(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function templateRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const kind = c.req.query("kind");
      return c.json({ templates: await listTemplates(c.var.deps, c.var.auth.orgId, kind === "project" || kind === "task" || kind === "doc" ? kind : undefined) });
    })
    .post("/", async (c) => c.json({ template: await saveTemplate(c.var.deps, c.var.auth, await parseBody(c, TemplateSave)) }, 201))
    .get("/:id", async (c) => c.json({ template: await getTemplate(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .post("/:id/use", async (c) => c.json(await useTemplate(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, TemplateUse.default({}))), 201))
    .delete("/:id", async (c) => c.json(await deleteTemplate(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function goalRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await goalTree(c.var.deps, c.var.auth.orgId, { includeArchived: c.req.query("archived") === "1" })))
    .post("/", async (c) => c.json({ goal: await createGoal(c.var.deps, c.var.auth, await parseBody(c, GoalCreate)) }, 201))
    .get("/:id", async (c) => c.json({ goal: await getGoal(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ goal: await updateGoal(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, GoalPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteGoal(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/key-results", async (c) => c.json({ keyResult: await addKeyResult(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, KrCreate)) }, 201));
}

export function keyResultRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .patch("/:id", async (c) => c.json({ keyResult: await updateKeyResult(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, KrPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteKeyResult(c.var.deps, c.var.auth, c.req.param("id"))));
}

/** The guest's chat: only channels of their project that a member shared with guests. */
export function guestChatRoutes() {
  const viewer = async (c: Context<AppEnv>): Promise<GuestViewer> => {
    const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
    if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
    return { orgId: g.guest.orgId, projectId: g.guest.projectId, guestId: g.guest.id, name: g.guest.name || g.guest.email };
  };
  return new Hono<AppEnv>()
    .get("/channels", async (c) => c.json({ channels: await guestChannels(c.var.deps, await viewer(c)) }))
    .get("/channels/:id/messages", async (c) => c.json(await guestMessages(c.var.deps, await viewer(c), c.req.param("id"), parseQuery(c, MessagesQuery))))
    .post("/channels/:id/messages", async (c) => {
      const g = await viewer(c);
      const b = await parseBody(c, ChatPost);
      return c.json({ message: await guestPost(c.var.deps, g, c.req.param("id"), { body: b.body, parentId: b.parentId, files: decodeAttachments(b.attachments) }) }, 201);
    })
    .get("/messages/:id/thread", async (c) => c.json(await guestThread(c.var.deps, await viewer(c), c.req.param("id"))))
    .get("/files/:id", async (c) => download(await readChatFile(c.var.deps, null, c.req.param("id"), await viewer(c))));
}

type ParentVars = { deps: AppEnv["Variables"]["deps"]; ip: string; requestId: string; log: AppEnv["Variables"]["log"] };

/** One router for every round 10 path, mounted lazily by app.ts, which hands over its request context. */
export function r10Routes(parentVars: WeakMap<Request, ParentVars>) {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      const p = parentVars.get(c.req.raw);
      if (p) { c.set("deps", p.deps); c.set("ip", p.ip); c.set("requestId", p.requestId); c.set("log", p.log); }
      await next();
    })
    .route("/api/chat", chatRoutes())
    .route("/api/templates", templateRoutes())
    .route("/api/goals", goalRoutes())
    .route("/api/key-results", keyResultRoutes())
    .route("/api/guest/chat", guestChatRoutes())
    // Round 20: reactions, chat search, first unread and calls (chat-r20.ts).
    .route("/api/chat", chatR20Routes())
    .route("/api/guest/chat", guestChatR20Routes())
    // Round 23: live call presence in chat (chat-r23-calls.ts).
    .route("/api/chat", chatR23CallRoutes())
    .route("/api/guest/chat", guestChatR23CallRoutes())
    // Round 32: live chat typing beat (chat-live-r32.ts).
    .route("/api/chat", chatLiveR32Routes());
}
