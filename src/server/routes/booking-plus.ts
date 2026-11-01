/**
 * R92 Booking plus routes (flag BOOKING_PLUS, needs SCHEDULING_ENABLED).
 *   Signed in, /api/booking:
 *     GET  /resources[?archived=1]          resources (admins also get each check in link)
 *     POST /resources, PATCH /resources/:id  admins only
 *     GET  /grid?date=YYYY-MM-DD             the day grid
 *     GET  /inbox                            my upcoming bookings, and requests waiting for approval (admins)
 *     POST /resource-bookings                { resourceId, startsAt, endsAt, title? }
 *     POST /resource-bookings/:id/cancel, POST /resource-bookings/:id/decide { approve }
 *     POST /resources/:id/check-in           { key } from the QR at the resource
 *     GET|POST /polls, GET|PATCH|DELETE /polls/:id, POST /polls/:id/pick { optionId }
 *     GET|POST /events, GET|PATCH|DELETE /events/:id, POST /events/:id/cancel, GET /events/:id/attendees.csv,
 *     POST /events/:id/check-in              { code, ticketId?, undo? }
 *   Public, /api/pub/booking (per IP limits; the spam shield on every form):
 *     GET /shield?form=book|poll|event, GET /polls/:token, POST /polls/:token/votes, PUT /polls/:token/votes/:id,
 *     GET /events/:slug, POST /events/:slug/rsvp, GET /tickets/:id?c=, POST /tickets/:id/cancel, GET /tickets/:id/qr.png?c=
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { RateLimiter } from "../lib/rate-limit";
import type { SuiteActor } from "../services/suite/common";
import { issueChallenge, requireShield } from "../services/spam-shield";
import { bookResource, cancelResourceBooking, checkInResource, dayGrid, decideResourceBooking, listResources, resourceInbox, saveResource } from "../services/booking/resources";
import { castVote, createPoll, deletePoll, editVote, listPolls, pickWinner, pollDetail, publicPoll, setPollOpen } from "../services/booking/polls";
import { attendeesCsv, cancelEvent, cancelTicket, checkInTicket, deleteEvent, eventDetail, listEvents, publicEvent, publicTicket, rsvp, saveEvent, ticketQrPng } from "../services/booking/events";
import { POLL_ANSWERS, RESOURCE_KINDS, WEEK_DAYS } from "@/shared/booking-plus";

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;

export const ShieldBody = z.object({
  challenge: z.object({ id: z.string().max(40), form: z.string().max(32), salt: z.string().max(40), difficulty: z.number().int().min(0).max(32), issuedAt: z.number(), expiresAt: z.number(), sig: z.string().max(128) }),
  nonce: z.number().int().min(0),
  hp: z.string().max(200).optional(),
});

const Hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a time like 09:00.");
const ResourceBody = z.object({
  name: z.string().max(200).optional(), kind: z.enum(RESOURCE_KINDS).optional(), location: z.string().max(400).optional(), description: z.string().max(4000).optional(),
  capacity: z.number().int().min(0).max(10_000).nullable().optional(), timezone: z.string().max(64).optional(), days: z.array(z.enum(WEEK_DAYS)).max(7).optional(),
  openFrom: Hhmm.optional(), openTo: Hhmm.optional(), stepMin: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
  minMin: z.number().int().min(15).max(1440).optional(), maxMin: z.number().int().min(15).max(1440).optional(), quotaMinWeek: z.number().int().min(15).max(10_080).nullable().optional(),
  needsApproval: z.boolean().optional(), checkinRequired: z.boolean().optional(), releaseAfterMin: z.number().int().min(5).max(120).optional(), archived: z.boolean().optional(),
});
const BookBody = z.object({ resourceId: z.string().max(60), startsAt: z.string().max(40), endsAt: z.string().max(40), title: z.string().max(400).optional() });
const PollBody = z.object({
  title: z.string().max(400), description: z.string().max(4000).optional(), location: z.string().max(400).optional(), durationMin: z.number().int().min(15).max(480).optional(),
  timezone: z.string().max(64).optional(), video: z.boolean().optional(), options: z.array(z.string().max(40)).min(1).max(30), deadlineAt: z.string().max(40).nullable().optional(),
});
const VoteBody = z.object({ name: z.string().max(200), email: z.string().max(300).optional(), answers: z.record(z.string().max(60), z.enum(POLL_ANSWERS)), shield: ShieldBody.optional() });
const EditVoteBody = VoteBody.extend({ editToken: z.string().max(60) });
const EventBody = z.object({
  title: z.string().max(400).optional(), description: z.string().max(10_000).optional(), location: z.string().max(400).optional(), onlineUrl: z.string().max(600).optional(),
  startsAt: z.string().max(40).optional(), endsAt: z.string().max(40).optional(), timezone: z.string().max(64).optional(), capacity: z.number().int().min(1).max(5000).nullable().optional(),
  waitlist: z.boolean().optional(), slug: z.string().max(60).optional(), status: z.enum(["draft", "published"]).optional(),
});
const RsvpBody = z.object({ name: z.string().max(200), email: z.string().max(300), shield: ShieldBody.optional() });

/** A per isolate limit plus the shared binding when one is bound (same as the booking page's). */
export function publicLimit(limit: number, key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
  const local = new RateLimiter(limit, 60_000);
  return async (c, next) => {
    const k = key(c);
    let ok = local.take(k);
    const bound = c.var.deps.rateLimiters?.webhooks;
    if (ok && bound && c.req.method !== "GET") ok = (await bound.limit({ key: `pub:${k}` })).success;
    if (!ok) {
      c.header("retry-after", "60");
      return c.json({ error: { code: "rate_limited", message: "Too many requests. Try again in a minute." } }, 429);
    }
    return next();
  };
}

export function bookingPlusRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/resources", async (c) => c.json({ resources: await listResources(c.var.deps, actor(c), { archived: c.req.query("archived") === "1" }) }))
    .post("/resources", requireAdmin, async (c) => c.json({ resource: await saveResource(c.var.deps, actor(c), await parseBody(c, ResourceBody)) }, 201))
    .patch("/resources/:id", requireAdmin, async (c) => c.json({ resource: await saveResource(c.var.deps, actor(c), await parseBody(c, ResourceBody), c.req.param("id")) }))
    .post("/resources/:id/check-in", async (c) => c.json(await checkInResource(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, z.object({ key: z.string().max(80) }))).key)))
    .get("/grid", async (c) => c.json(await dayGrid(c.var.deps, actor(c), c.req.query("date") ?? "")))
    .get("/inbox", async (c) => c.json(await resourceInbox(c.var.deps, actor(c))))
    .post("/resource-bookings", async (c) => c.json(await bookResource(c.var.deps, actor(c), await parseBody(c, BookBody)), 201))
    .post("/resource-bookings/:id/cancel", async (c) => c.json(await cancelResourceBooking(c.var.deps, actor(c), c.req.param("id"))))
    .post("/resource-bookings/:id/decide", async (c) => c.json(await decideResourceBooking(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, z.object({ approve: z.boolean() }))).approve)))
    .get("/polls", async (c) => c.json({ polls: await listPolls(c.var.deps, actor(c)) }))
    .post("/polls", async (c) => c.json(await createPoll(c.var.deps, actor(c), await parseBody(c, PollBody)), 201))
    .get("/polls/:id", async (c) => c.json(await pollDetail(c.var.deps, actor(c), c.req.param("id"))))
    .patch("/polls/:id", async (c) => c.json(await setPollOpen(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, z.object({ open: z.boolean() }))).open)))
    .delete("/polls/:id", async (c) => c.json(await deletePoll(c.var.deps, actor(c), c.req.param("id"))))
    .post("/polls/:id/pick", async (c) => c.json(await pickWinner(c.var.deps, actor(c), c.req.param("id"), (await parseBody(c, z.object({ optionId: z.string().max(60) }))).optionId)))
    .get("/events", async (c) => c.json({ events: await listEvents(c.var.deps, actor(c)) }))
    .post("/events", async (c) => c.json(await saveEvent(c.var.deps, actor(c), await parseBody(c, EventBody)), 201))
    .get("/events/:id", async (c) => c.json(await eventDetail(c.var.deps, actor(c), c.req.param("id"))))
    .patch("/events/:id", async (c) => c.json(await saveEvent(c.var.deps, actor(c), await parseBody(c, EventBody), c.req.param("id"))))
    .delete("/events/:id", async (c) => c.json(await deleteEvent(c.var.deps, actor(c), c.req.param("id"))))
    .post("/events/:id/cancel", async (c) => c.json(await cancelEvent(c.var.deps, actor(c), c.req.param("id"))))
    .post("/events/:id/check-in", async (c) => c.json(await checkInTicket(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, z.object({ code: z.string().max(200), ticketId: z.string().max(60).nullable().optional(), undo: z.boolean().optional() })))))
    .get("/events/:id/attendees.csv", async (c) => {
      const { filename, csv } = await attendeesCsv(c.var.deps, actor(c), c.req.param("id"));
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "")}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    });
}

export function bookingPublicRoutes() {
  const reads = publicLimit(120, (c) => `bpr:${c.var.ip}`);
  const writes = publicLimit(10, (c) => `bpw:${c.var.ip}`);
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { await next(); c.header("cache-control", "private, no-store"); c.header("x-robots-tag", "noindex"); })
    .get("/shield", reads, async (c) => c.json({ challenge: await issueChallenge(c.var.deps, c.req.query("form") ?? "") }))
    .get("/polls/:token", reads, async (c) => c.json(await publicPoll(c.var.deps, c.req.param("token"))))
    .post("/polls/:token/votes", writes, async (c) => {
      const b = await parseBody(c, VoteBody);
      await requireShield(c.var.deps, "poll", b.shield);
      return c.json(await castVote(c.var.deps, c.req.param("token"), b), 201);
    })
    .put("/polls/:token/votes/:id", writes, async (c) => c.json(await editVote(c.var.deps, c.req.param("token"), c.req.param("id"), await parseBody(c, EditVoteBody))))
    .get("/events/:slug", reads, async (c) => c.json(await publicEvent(c.var.deps, c.req.param("slug"))))
    .post("/events/:slug/rsvp", writes, async (c) => {
      const b = await parseBody(c, RsvpBody);
      await requireShield(c.var.deps, "event", b.shield);
      return c.json(await rsvp(c.var.deps, c.req.param("slug"), b), 201);
    })
    .get("/tickets/:id", reads, async (c) => c.json(await publicTicket(c.var.deps, c.req.param("id"), c.req.query("c") ?? "")))
    .post("/tickets/:id/cancel", writes, async (c) => c.json(await cancelTicket(c.var.deps, c.req.param("id"), (await parseBody(c, z.object({ c: z.string().max(20) }))).c)))
    .get("/tickets/:id/qr.png", reads, async (c) => new Response(await ticketQrPng(c.var.deps, c.req.param("id"), c.req.query("c") ?? "") as Uint8Array<ArrayBuffer>, {
      headers: { "content-type": "image/png", "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" },
    }));
}
