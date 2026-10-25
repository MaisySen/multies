/**
 * Round 23 (R23.3) calls in chat, cookie session: who is in a channel's call now, a client
 * leaving a call, and (local E2E only) a fake room list. Mounted beside the round 20 chat routes.
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { GUEST_COOKIE, resolveGuest } from "../services/suite/guests";
import { channelCallStatus, guestChannelCallStatus, leftCall, meetingCallStatus, setTestRoom } from "../services/suite/calls";

export const TestRoomBody = z.object({ participants: z.array(z.object({ name: z.string().trim().min(1).max(60) })).max(50) });

export function chatR23CallRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/channels/:id/call", async (c) => c.json(await channelCallStatus(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/calls/:meetingId", async (c) => c.json(await meetingCallStatus(c.var.deps, c.var.auth, c.req.param("meetingId"))))
    .post("/calls/:meetingId/left", async (c) => c.json(await leftCall(c.var.deps, c.var.auth, c.req.param("meetingId"))))
    // Local E2E only: 404 unless CALLS_TEST_HOOK is on, which loadConfig refuses in production.
    .post("/calls/:meetingId/test-room", async (c) => c.json(await setTestRoom(c.var.deps, c.var.auth, c.req.param("meetingId"), (await parseBody(c, TestRoomBody)).participants)));
}

export function guestChatR23CallRoutes() {
  const viewer = async (c: Context<AppEnv>) => {
    const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
    if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
    return { orgId: g.guest.orgId, projectId: g.guest.projectId, guestId: g.guest.id, name: g.guest.name || g.guest.email };
  };
  return new Hono<AppEnv>()
    .get("/channels/:id/call", async (c) => c.json(await guestChannelCallStatus(c.var.deps, await viewer(c), c.req.param("id"))));
}
