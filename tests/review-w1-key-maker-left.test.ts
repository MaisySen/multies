/**
 * Wave 1 review V6: a workspace key acts with its maker's current role (Round 2), but a key whose maker left, was
 * removed or deleted their account resolved as a full admin again, undoing that cap. Now such a key keeps working with
 * a member's role (no person behind it), and Settings, Developers flags it (makerLeft).
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { resolveApiKey } from "@/server/services/developer/api-keys";
import { users } from "@/server/db/schema";

async function world() {
  const ctx = await makeTestApp();
  const owner = new Client(ctx.app);
  await owner.signup("olive@acme.io", "Olive Owner");
  const join = async (email: string, role: "admin" | "member") => {
    const inv = await owner.post("/api/team/invites", { email, role });
    const c = new Client(ctx.app);
    await c.signup(email, "Ada", "Ada Co");
    expect((await c.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    const id = (await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get())!.id;
    return { c, id };
  };
  return { ctx, owner, join };
}

describe("Wave 1 review V6: a key whose maker left acts as a member", () => {
  it("demoted then removed: the key stays a member and keeps working; the list flags it", async () => {
    const { ctx, owner, join } = await world();
    const ada = await join("ada@acme.io", "admin");
    const secret = (await ada.c.post("/api/developer/keys", { name: "Ada script" })).body.secret as string;
    const role = async () => (await resolveApiKey(ctx.deps, `Bearer ${secret}`))?.role;
    expect(await role()).toBe("admin");
    expect((await owner.patch(`/api/team/members/${ada.id}`, { role: "member" })).status).toBe(200);
    expect(await role()).toBe("member");
    expect((await owner.del(`/api/team/members/${ada.id}`)).status).toBe(200);
    expect(await role()).toBe("member");
    // It still works for what a member may do.
    const res = await ctx.app.request("/api/v1/tasks", { headers: { host: "localhost", authorization: `Bearer ${secret}` } });
    expect(res.status).toBe(200);
    const keys = (await owner.get("/api/developer/keys")).body;
    const list = keys.apiKeys as { name: string; makerLeft?: boolean }[];
    expect(list.find((k) => k.name === "Ada script")?.makerLeft).toBe(true);
  });

  it("an admin removed while still an admin: the key is a member, not an admin", async () => {
    const { ctx, owner, join } = await world();
    const ada = await join("ada@acme.io", "admin");
    const secret = (await ada.c.post("/api/developer/keys", { name: "Ada script" })).body.secret as string;
    expect((await owner.del(`/api/team/members/${ada.id}`)).status).toBe(200);
    expect((await resolveApiKey(ctx.deps, `Bearer ${secret}`))?.role).toBe("member");
    // An admin only route answers 403 for it.
    const r = await ctx.app.request("/api/v1/data-moves/exports", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
  });
});
