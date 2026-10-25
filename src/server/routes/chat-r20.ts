/**
 * Round 20 chat polish in the app (cookie session): reactions, search inside chat, first unread
 * and a call from a channel or DM. Mounted beside the round 10 chat routes (suite-r10.ts).
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { GUEST_COOKIE, resolveGuest } from "../services/suite/guests";
import { firstUnread, guestToggleReaction, searchChat, startChannelCall, toggleReaction } from "../services/suite/chat-reactions";

export const ReactionToggle = z.object({ emoji: z.string().trim().min(1).max(64) });
export const ChatSearchQuery = z.object({ q: z.string().max(200).default(""), channelId: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });

export function chatR20Routes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/messages/:id/reactions", async (c) => c.json(await toggleReaction(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, ReactionToggle)).emoji)))
    .get("/search", async (c) => c.json(await searchChat(c.var.deps, c.var.auth, parseQuery(c, ChatSearchQuery))))
    .get("/channels/:id/first-unread", async (c) => c.json(await firstUnread(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/channels/:id/call", async (c) => {
      const out = await startChannelCall(c.var.deps, c.var.auth, c.req.param("id"));
      return c.json(out, out.joined ? 200 : 201);
    });
}

export function guestChatR20Routes() {
  const viewer = async (c: Context<AppEnv>) => {
    const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
    if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
    return { orgId: g.guest.orgId, projectId: g.guest.projectId, guestId: g.guest.id, name: g.guest.name || g.guest.email };
  };
  return new Hono<AppEnv>()
    .post("/messages/:id/reactions", async (c) => {
      const g = await viewer(c);
      return c.json(await guestToggleReaction(c.var.deps, g, c.req.param("id"), (await parseBody(c, ReactionToggle)).emoji));
    });
}
