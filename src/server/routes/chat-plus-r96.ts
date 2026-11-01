/**
 * R96 chat plus in the app (cookie session): topics, announcements, polls, decision votes, live Q&A and word clouds.
 * Mounted at /api/chat-plus behind the chat_plus flag (CHAT_PLUS). Guests get poll results read only.
 */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { GUEST_COOKIE, resolveGuest } from "../services/suite/guests";
import {
  addQuestion, announcementFeed, announcementReceipts, closePoll, createPoll, createTopic, getPoll, guestPoll, listTopics, markAnnouncementsSeen,
  markAnswered, markTopicRead, meetingPolls, moveMessage, postAnnouncement, toggleUpvote, updateTopic, vote,
} from "../services/suite/chat-plus";
import { CHAT_PLUS_LIMITS as L, POLL_KINDS } from "../../shared/chat-plus";

const id64 = z.string().min(1).max(64);
export const TopicCreate = z.object({ name: z.string().max(200) });
export const TopicPatch = z.object({ name: z.string().max(200).optional(), merge: z.boolean().optional(), resolved: z.boolean().optional() });
export const MoveBody = z.object({ topicId: id64.nullable() });
export const AnnouncementBody = z.object({ body: z.string().max(20_000), topicId: id64.nullable().optional() });
export const SeenBody = z.object({ messageIds: z.array(id64).min(1).max(100) });
export const PollCreate = z.object({
  kind: z.enum(POLL_KINDS), question: z.string().max(2000), options: z.array(z.string().max(500)).max(20).optional(), multi: z.boolean().optional(),
  anonymous: z.boolean().optional(), closesAt: z.string().max(40).nullable().optional(), channelId: id64.nullable().optional(), topicId: id64.nullable().optional(),
  meetingId: id64.nullable().optional(),
});
export const VoteBody = z.object({ choices: z.array(z.string().max(200)).max(20), reason: z.string().max(L.reason * 2).optional() });
export const QuestionBody = z.object({ body: z.string().max(2000) });
export const AnsweredBody = z.object({ answered: z.boolean() });
const FeedQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

export function chatPlusRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/status", (c) => c.json({ on: true }))
    .get("/channels/:id/topics", async (c) => c.json(await listTopics(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/channels/:id/topics", async (c) => {
      const r = await createTopic(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, TopicCreate)).name);
      return c.json(r, r.created ? 201 : 200);
    })
    .patch("/topics/:id", async (c) => c.json(await updateTopic(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, TopicPatch))))
    .post("/topics/:id/read", async (c) => c.json(await markTopicRead(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/messages/:id/topic", async (c) => c.json(await moveMessage(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, MoveBody)).topicId)))
    .get("/announcements", async (c) => c.json(await announcementFeed(c.var.deps, c.var.auth, parseQuery(c, FeedQuery))))
    .post("/channels/:id/announcements", async (c) => c.json(await postAnnouncement(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, AnnouncementBody)), 201))
    .post("/announcements/seen", async (c) => c.json(await markAnnouncementsSeen(c.var.deps, c.var.auth, (await parseBody(c, SeenBody)).messageIds)))
    .get("/announcements/:id/receipts", async (c) => c.json(await announcementReceipts(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/polls", async (c) => c.json(await createPoll(c.var.deps, c.var.auth, await parseBody(c, PollCreate)), 201))
    .get("/polls/:id", async (c) => c.json(await getPoll(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/polls/:id/vote", async (c) => c.json(await vote(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, VoteBody))))
    .post("/polls/:id/close", async (c) => c.json(await closePoll(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/polls/:id/questions", async (c) => c.json(await addQuestion(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, QuestionBody)).body), 201))
    .post("/questions/:id/upvote", async (c) => c.json(await toggleUpvote(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/questions/:id/answered", async (c) => c.json(await markAnswered(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, AnsweredBody)).answered)))
    .get("/meetings/:id/polls", async (c) => c.json(await meetingPolls(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function guestChatPlusRoutes() {
  return new Hono<AppEnv>()
    .get("/polls/:id", async (c) => {
      const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
      if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
      return c.json(await guestPoll(c.var.deps, { orgId: g.guest.orgId, projectId: g.guest.projectId, guestId: g.guest.id, name: g.guest.name || g.guest.email }, c.req.param("id")));
    });
}
