/**
 * Round 23 (R23.4) in the public API (v1): calendar events in a window (meetings and task due
 * dates; a workspace or agent key sees the whole workspace's) and the key's own calendar feed.
 * A key's feed is the feed of the person who made it (an agent member's key: the agent's). The
 * feed address is shown only once, in the reset answer.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { feedStatus, listCalendarEvents, resetFeed } from "../services/suite/calendar-sync";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = (description: string) => ({ description, content: { "application/json": { schema: z.record(z.string(), z.unknown()) } } });
const Window = z.object({
  from: z.string().max(40).optional().openapi({ param: { name: "from", in: "query" }, example: "2026-11-01" }),
  to: z.string().max(40).optional().openapi({ param: { name: "to", in: "query" }, example: "2026-12-01" }),
});
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

export function registerCalendarRoutes(api: OpenAPIHono<AppEnv>) {
  const route = (method: "get" | "post", path: string, summary: string, description: string, extra: Record<string, unknown> = {}) =>
    createRoute({ method, path, tags: ["Calendar"], summary, description, security: [{ bearerAuth: [] }], ...extra, responses: { 200: json("OK."), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 422: err("Validation failed.") } });

  api.openapi(route("get", "/calendar/events", "List calendar events", "Meetings (weekly series expanded) and task due dates (all day) between from and to (ISO dates or instants, at most 100 days apart; default the week before today and 4 weeks after). Each: { id, kind: meeting | due, title, start, end, allDay, url }. API keys see the workspace's meetings and due dates; a person's other calendars are only in the app and over MCP with the person's own sign in.", { request: { query: Window } }),
    async (c) => send(c, await listCalendarEvents(c.var.deps, actor(c), { from: c.req.query("from"), to: c.req.query("to"), external: false })));
  api.openapi(route("get", "/calendar/feed", "Calendar feed status", "Whether the key's user has a calendar feed (an .ics address for Google Calendar, Apple Calendar or Outlook): { enabled, hint (last 4 characters), includeTasks, createdAt, resetAt }. The address itself is never returned here. A key acts for the person who made it."),
    async (c) => send(c, { feed: await feedStatus(c.var.deps, actor(c)) }));
  api.openapi(route("post", "/calendar/feed/reset", "Turn on or reset the calendar feed", "Makes a new secret feed address and returns it once as url and webcalUrl. Any earlier address stops working at once. Only the person signed in (the app, or their own OAuth sign in): an API key gets 403 person_only."),
    async (c) => send(c, { feed: await resetFeed(c.var.deps, actor(c)) }));
}
