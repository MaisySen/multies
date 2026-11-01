/**
 * Round 21 in the public API (v1): search everything, My Work, and chat reactions and chat search
 * (the round 20 features, which had only MCP tools and app routes until now). Reads write nothing;
 * a reaction is 2 rows. Keys see what they could already open: an agent key its own inboxes and
 * public channels, a read only key nothing that writes.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { HttpError } from "../lib/errors";
import type { SuiteActor } from "../services/suite/common";
import { myWork, parseTypes, searchEverything } from "../services/search";
import { searchChat, toggleReaction } from "../services/suite/chat-reactions";
import { ChatSearchQuery, ReactionToggle } from "./chat-r20";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errors = { 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } as const;
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const secured = [{ bearerAuth: [] }];
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;
const limitOf = (raw: string | undefined, max: number) => {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new HttpError(422, "validation_failed", `limit is a whole number from 1 to ${max}.`);
  return Number(raw);
};

const SearchQ = z.object({
  q: z.string().openapi({ param: { name: "q", in: "query" }, example: "invoice" }),
  types: z.string().optional().openapi({ param: { name: "types", in: "query" }, example: "tasks,docs" }),
  limit: z.string().optional().openapi({ param: { name: "limit", in: "query" }, example: "5" }),
});
const TzQ = z.object({ tz: z.string().max(64).optional().openapi({ param: { name: "tz", in: "query" }, example: "Australia/Sydney" }) });
const ChatQ = z.object({
  q: z.string().optional().openapi({ param: { name: "q", in: "query" } }),
  channelId: z.string().optional().openapi({ param: { name: "channelId", in: "query" } }),
  limit: z.string().optional().openapi({ param: { name: "limit", in: "query" } }),
});
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });

export function registerR21Routes(api: OpenAPIHono<AppEnv>, keyAuth: MiddlewareHandler<AppEnv>) {
  api.use("/my-work", keyAuth);
  const route = (method: "get" | "post", path: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: [tag], summary, description, security: secured, ...extra, responses: { 200: json("OK."), 401: errors[401], 403: errors[403], 404: errors[404], 422: errors[422] } });

  api.openapi(route("get", "/search/everything", "Search", "Search everything",
    "One search across mail, tasks (title, notes or a key like OPS-12), docs, chat, contacts and deals, grouped by type, newest first. q needs 2 to 100 characters; types is a comma list of mail, tasks, docs, chat, contacts, deals; limit is per group (1 to 20, default 5). Only what the key can open: an agent key sees its own inboxes and public channels. Writes nothing.",
    { request: { query: SearchQ } }),
  async (c) => {
    const q = c.req.query("q") ?? "";
    const out = await searchEverything(c.var.deps, { kind: "actor", actor: actor(c) }, q, { types: parseTypes(c.req.query("types"), !!c.var.deps.config.searchR98), limit: limitOf(c.req.query("limit"), 20) });
    return send(c, out);
  });

  api.openapi(route("get", "/my-work", "Search", "My Work",
    "What is waiting today for the key's person (or, with an agent key, the agent): tasks due today and overdue, mentions, mail threads on my tasks, approvals waiting, today's meetings and snoozed mail coming back. tz is an IANA zone for today, e.g. Australia/Sydney. Writes nothing.",
    { request: { query: TzQ } }),
  async (c) => send(c, await myWork(c.var.deps, actor(c), { timeZone: c.req.query("tz") })));

  api.openapi(route("get", "/chat/search", "Chat", "Search chat",
    "Messages and thread replies containing q, newest first, in the public channels the key can read (or one channel with channelId). limit 1 to 50.",
    { request: { query: ChatQ } }),
  async (c) => {
    const r = ChatSearchQuery.safeParse(c.req.query());
    if (!r.success) throw new HttpError(422, "validation_failed", "Send q (up to 200 characters), and optionally channelId and limit (1 to 50).");
    return send(c, await searchChat(c.var.deps, actor(c), r.data));
  });

  api.openapi(route("post", "/chat/messages/{id}/reactions", "Chat", "React to a chat message",
    "Body: { emoji }. Adds one emoji reaction to a message or thread reply in a public channel, or takes it off when this key already reacted with it. The answer has added (true or false) and the message's reactions with counts. Read only keys can't react.",
    { request: { params: Id, body: { required: true, content: { "application/json": { schema: z.object({ emoji: z.string().openapi({ example: "\u{1F44D}" }) }) } } } } }),
  async (c) => {
    const b = ReactionToggle.safeParse(await c.req.json().catch(() => ({})));
    if (!b.success) throw new HttpError(422, "validation_failed", "React with one emoji: { \"emoji\": \"...\" }.");
    return send(c, await toggleReaction(c.var.deps, actor(c), c.req.param("id") ?? "", b.data.emoji));
  });
}
