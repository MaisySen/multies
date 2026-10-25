/**
 * Round 23 (R23.4): calendar sync in the web app (cookie session) at /api/calendar, and the public
 * feed at /cal/<token>.ics (no cookie: the token is the only key). Serving the feed writes nothing:
 * it is limited per token in memory, and answers HEAD and If-None-Match with the ETag.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { RateLimiter } from "../lib/rate-limit";
import {
  addCalDavSource, addIcsSource, calendarOptions, disableFeed, FEED_RATE_PER_MIN, feedStatus, listCalendarEvents, listSources, removeSource, resetFeed, serveFeed, updateFeed, updateSource,
} from "../services/suite/calendar-sync";

export const SourceCreate = z.union([
  z.object({ kind: z.literal("ics"), url: z.string().min(8).max(2000), name: z.string().max(160).optional(), color: z.string().max(7).optional() }),
  z.object({ kind: z.literal("caldav"), connectionId: z.string().min(1).max(100), url: z.string().max(2000).optional(), name: z.string().max(160).optional(), color: z.string().max(7).optional() }),
]);
export const SourcePatch = z.object({ enabled: z.boolean().optional(), name: z.string().max(160).optional(), color: z.string().max(7).optional() });
export const EventsQuery = z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional() });

export function calendarRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/feed", async (c) => c.json({ feed: await feedStatus(c.var.deps, c.var.auth) }))
    .post("/feed", async (c) => c.json({ feed: await resetFeed(c.var.deps, c.var.auth, await parseBody(c, z.object({ includeTasks: z.boolean().optional() }))) }))
    .patch("/feed", async (c) => c.json({ feed: await updateFeed(c.var.deps, c.var.auth, await parseBody(c, z.object({ includeTasks: z.boolean() }))) }))
    .delete("/feed", async (c) => c.json(await disableFeed(c.var.deps, c.var.auth)))
    .get("/events", async (c) => c.json(await listCalendarEvents(c.var.deps, c.var.auth, parseQuery(c, EventsQuery))))
    .get("/sources", async (c) => c.json({ data: await listSources(c.var.deps, c.var.auth) }))
    .get("/sources/options", async (c) => c.json({ data: await calendarOptions(c.var.deps, c.var.auth) }))
    .post("/sources", async (c) => {
      const b = await parseBody(c, SourceCreate);
      const s = b.kind === "ics" ? await addIcsSource(c.var.deps, c.var.auth, b) : await addCalDavSource(c.var.deps, c.var.auth, b);
      return c.json({ source: s }, 201);
    })
    .patch("/sources/:id", async (c) => c.json({ source: await updateSource(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SourcePatch)) }))
    .delete("/sources/:id", async (c) => c.json(await removeSource(c.var.deps, c.var.auth, c.req.param("id"))));
}

const notFoundIcs = () => new Response("Not found. This calendar address was reset or turned off.\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** GET and HEAD /cal/<token>.ics */
export function calendarFeedRoutes() {
  // In memory per isolate (the existing fixed window limiter), so a poll writes no limiter row.
  const tokenLimiter = new RateLimiter(FEED_RATE_PER_MIN, 60_000);
  const ipLimiter = new RateLimiter(FEED_RATE_PER_MIN * 10, 60_000);
  return new Hono<AppEnv>().on(["GET", "HEAD"], "/:file", async (c) => {
    const m = c.req.param("file").match(/^([A-Za-z0-9]{1,80})\.ics$/);
    if (!m) return notFoundIcs();
    if (!ipLimiter.take(c.var.ip) || !tokenLimiter.take(m[1])) {
      return new Response("Too many requests. Calendar apps refresh this about once an hour.\n", { status: 429, headers: { "retry-after": "60", "content-type": "text/plain; charset=utf-8" } });
    }
    const feed = await serveFeed(c.var.deps, m[1]);
    if (!feed) return notFoundIcs();
    const headers = {
      "content-type": "text/calendar; charset=utf-8", "cache-control": "private, max-age=300", etag: feed.etag,
      "content-disposition": "inline; filename=\"multies.ics\"", "x-robots-tag": "noindex", "referrer-policy": "no-referrer",
    };
    const inm = c.req.header("if-none-match");
    if (inm && inm.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(feed.etag)) return new Response(null, { status: 304, headers });
    return new Response(c.req.method === "HEAD" ? null : feed.body, { status: 200, headers: { ...headers, "content-length": String(new TextEncoder().encode(feed.body).length) } });
  });
}
