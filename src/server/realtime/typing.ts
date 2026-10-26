/**
 * Round 32: "Maya is typing". Ephemeral: nothing is stored and nothing is written to D1. The
 * browser sends at most one beat per 3 seconds while someone types; the server drops beats from
 * the same person in the same channel that come faster than that (per process).
 */
import type { Deps } from "../context";
import { HttpError } from "../lib/errors";
import { actorOf, assertWritable, type SuiteActor } from "../services/suite/common";
import { visibleChannel } from "../services/suite/chat";
import { publishChat } from "./publish";

/** The browser sends a typing beat at most this often. */
export const TYPING_THROTTLE_MS = 3000;
/** Viewers hide "is typing" this long after the last beat. */
export const TYPING_TTL_MS = 6000;

const lastBeat = new Map<string, number>();

/** Sends a typing beat for this actor in a channel they can read. Returns whether it went out. */
export async function sendTyping(deps: Deps, a: SuiteActor, channelId: string) {
  assertWritable(a);
  const c = await visibleChannel(deps, a, channelId);
  if (c.archived) return { ok: true, sent: false };
  const who = actorOf(a);
  if (who.type === "system" || !who.id) throw new HttpError(403, "forbidden", "Only people and agents type.");
  const userId = who.type === "member" ? who.id : `agent:${who.id}`;
  const now = deps.now().getTime();
  const key = `${c.id}:${userId}`;
  const prev = lastBeat.get(key) ?? 0;
  if (now - prev < TYPING_THROTTLE_MS - 250) return { ok: true, sent: false };
  lastBeat.set(key, now);
  if (lastBeat.size > 5000) for (const [k, t] of lastBeat) if (now - t > TYPING_TTL_MS) lastBeat.delete(k);
  await publishChat(deps, c, { t: "typing", channelId: c.id, userId, name: (who.name || "Someone").slice(0, 80) });
  return { ok: true, sent: true };
}
