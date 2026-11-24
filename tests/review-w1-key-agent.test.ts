/**
 * Wave 1 review V2 (high): a workspace key counts as nobody for personal mailboxes (Round 2), but the agent paths still
 * compared actor.userId (the key's maker): POST/PATCH /api/v1/agents with the maker's personal mailbox passed, and the
 * maker's key could mint an agent key for her agent that works her personal mailbox. Both now use personOf, so a key
 * is refused, and an agent a key makes records no person as its maker.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { agents } from "@/server/db/schema";

type W = Awaited<ReturnType<typeof privacyWorld>>;
async function v1(w: W, key: string, method: string, path: string, body?: unknown) {
  const res = await w.ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("Wave 1 review V2: a workspace key can't route its maker's personal mailbox through an agent", () => {
  it("refuses create, update and key minting with the maker's own key; the maker in the app still may", async () => {
    const w = await privacyWorld();
    expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { role: "admin" })).status).toBe(200);
    const key = (await w.pat.c.post("/api/developer/keys", { name: "ws" })).body.secret as string;
    // Create with her personal mailbox: refused.
    const made = await v1(w, key, "POST", "/agents", { name: "Key bot", localPart: `keybot${w.n}`, mailboxIds: [w.boxes.personal] });
    expect(made.status).toBe(403);
    // A team agent made by the key records no person as its maker, and can't be given her personal mailbox.
    const team = await v1(w, key, "POST", "/agents", { name: "Key team bot", localPart: `keyteam${w.n}`, mailboxIds: [w.boxes.team] });
    expect(team.status).toBe(201);
    const id = (team.body.agent?.id ?? team.body.id) as string;
    expect((await w.ctx.db.select({ m: agents.createdByUserId }).from(agents).where(eq(agents.id, id)).get())?.m).toBeNull();
    expect((await v1(w, key, "PATCH", `/agents/${id}`, { mailboxIds: [w.boxes.team, w.boxes.personal] })).status).toBe(403);
    // Pat in the app makes an agent on her personal mailbox; her key can't mint a key for it.
    const mine = await w.pat.c.post("/api/agents", { name: "Pat helper", localPart: `pathelp${w.n}`, mailboxIds: [w.boxes.personal], allowedRecipients: null });
    expect(mine.status).toBe(201);
    expect((await v1(w, key, "POST", `/agents/${mine.body.agent.id}/keys`, { name: "x" })).status).toBe(403);
    expect((await w.pat.c.post(`/api/agents/${mine.body.agent.id}/keys`, { name: "mine" })).status).toBe(201);
  }, 120_000);
});
