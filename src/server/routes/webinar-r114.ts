/**
 * R114 webinar routes (flag WEBINAR_R114). Members: /api/webinars/:meetingId (settings, stage, moderation, report,
 * replay; hosts and admins change things). Public: /api/public/webinars (the registration page and the attendee's
 * personal link). Attendees never get another attendee's email.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { notFound } from "../lib/errors";
import {
  attendeeAsk, attendeeChat, attendeeJoin, attendeeReplay, attendeeState, attendeeUpvote, attendeeVote, getWebinar, heartbeat, hideChat, hostChat, hostClosePoll,
  hostPoll, liveView, moderateQuestion, publicInfo, register, setPanelist, setReplay, updateWebinar, webinarOn, webinarReport, webinarReportCsv,
} from "../services/suite/webinar-r114";

const id64 = z.string().min(1).max(80);
export const WebinarPatch = z.object({
  enabled: z.boolean().optional(), registrationOpen: z.boolean().optional(), chatMode: z.enum(["everyone", "hosts", "off"]).optional(), description: z.string().max(2000).optional(),
});
export const PanelistBody = z.object({ kind: z.enum(["member", "registrant"]), id: id64, on: z.boolean() });
export const ModerateBody = z.object({ hidden: z.boolean().optional(), answer: z.string().max(2000).nullable().optional(), answered: z.boolean().optional() });
export const ChatBody = z.object({ body: z.string().max(2000) });
export const HideBody = z.object({ hidden: z.boolean() });
export const PollBody = z.object({ question: z.string().max(500), options: z.array(z.string().max(200)).max(10), multi: z.boolean().optional() });
export const ReplayBody = z.object({ recordingId: id64.nullable(), shared: z.boolean() });
export const RegisterBody = z.object({ name: z.string().max(200).optional(), email: z.string().max(320).optional(), website: z.string().max(200).optional(), openedAt: z.number().int().optional() });
export const AskBody = z.object({ body: z.string().max(2000) });
export const VoteBody = z.object({ choices: z.array(z.string().max(100)).max(10) });

const gate = async (c: { var: AppEnv["Variables"] }, next: () => Promise<void>) => { if (!webinarOn(c.var.deps)) throw notFound("Page"); await next(); };

export function webinarRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", gate)
    .get("/:id", async (c) => c.json(await getWebinar(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/:id", async (c) => c.json(await updateWebinar(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, WebinarPatch))))
    .post("/:id/panelists", async (c) => c.json(await setPanelist(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PanelistBody))))
    .get("/:id/live", async (c) => c.json(await liveView(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/questions/:itemId", async (c) => c.json(await moderateQuestion(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"), await parseBody(c, ModerateBody))))
    .post("/:id/chat", async (c) => c.json(await hostChat(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, ChatBody)).body), 201))
    .post("/:id/chat/:messageId/hide", async (c) => c.json(await hideChat(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("messageId"), (await parseBody(c, HideBody)).hidden)))
    .post("/:id/polls", async (c) => c.json(await hostPoll(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, PollBody)), 201))
    .post("/:id/polls/:pollId/close", async (c) => c.json(await hostClosePoll(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("pollId"))))
    .put("/:id/replay", async (c) => c.json(await setReplay(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ReplayBody))))
    .get("/:id/report", async (c) => c.json(await webinarReport(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:id/report.csv", async (c) => {
      const r = await webinarReportCsv(c.var.deps, c.var.auth, c.req.param("id"));
      return new Response(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.filename}"`, "cache-control": "no-store" } });
    });
}

export function publicWebinarRoutes() {
  const noStore = { "cache-control": "no-store" };
  return new Hono<AppEnv>()
    .use("*", gate)
    .get("/r/:slug", async (c) => c.json(await publicInfo(c.var.deps, c.req.param("slug")), 200, noStore))
    .post("/r/:slug/register", async (c) => c.json(await register(c.var.deps, c.req.param("slug"), await parseBody(c, RegisterBody), c.var.ip ?? ""), 201, noStore))
    .get("/a/:token", async (c) => c.json(await attendeeState(c.var.deps, c.req.param("token")), 200, noStore))
    .post("/a/:token/join", async (c) => c.json(await attendeeJoin(c.var.deps, c.req.param("token")), 200, noStore))
    .post("/a/:token/heartbeat", async (c) => c.json(await heartbeat(c.var.deps, c.req.param("token")), 200, noStore))
    .post("/a/:token/questions", async (c) => c.json(await attendeeAsk(c.var.deps, c.req.param("token"), (await parseBody(c, AskBody)).body), 201, noStore))
    .post("/a/:token/questions/:itemId/upvote", async (c) => c.json(await attendeeUpvote(c.var.deps, c.req.param("token"), c.req.param("itemId")), 200, noStore))
    .post("/a/:token/polls/:pollId/vote", async (c) => c.json(await attendeeVote(c.var.deps, c.req.param("token"), c.req.param("pollId"), (await parseBody(c, VoteBody)).choices), 200, noStore))
    .post("/a/:token/chat", async (c) => c.json(await attendeeChat(c.var.deps, c.req.param("token"), (await parseBody(c, ChatBody)).body), 201, noStore))
    .get("/a/:token/replay", async (c) => c.json(await attendeeReplay(c.var.deps, c.req.param("token")), 200, noStore));
}
