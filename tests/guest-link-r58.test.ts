import { beforeEach, describe, expect, it } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * R58 (MB-253): when the guest invite email does not go out, the inviting person gets the link in the answer, and can
 * get a fresh one later for a guest who has not joined, with no email sent. An agent never gets a link.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => { ctx = await makeTestApp(); c = new Client(ctx.app); await c.signup(); });

const project = async () => (await c.post("/api/projects", { name: `Harbour ${Math.random().toString(36).slice(2, 6)}` })).body.project as { id: string };
const sentCount = () => ((ctx.outbound as unknown as { sent?: unknown[] }).sent ?? []).length;

describe("guest invite link when the email does not go out (R58 MB-253)", () => {
  it("answers not_sent with the invite link, and the link opens the project for the guest", async () => {
    const p = await project();
    const inv = await c.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee" });
    expect(inv.status).toBe(201);
    expect(inv.body.delivery.status).toBe("not_sent");
    expect(inv.body.inviteUrl).toMatch(/\/g\/[A-Za-z0-9_-]{20,}$/);
    const g = new Client(ctx.app);
    expect((await g.post("/api/guest/accept", { token: (inv.body.inviteUrl as string).split("/g/")[1] })).status).toBe(200);
  });

  it("gives a fresh link for a pending guest without sending email; the old link stops working", async () => {
    const p = await project();
    const inv = await c.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee" });
    const before = sentCount();
    const r = await c.post(`/api/guests/${inv.body.guest.id}/link`, {});
    expect(r.status).toBe(200);
    expect(r.body.inviteUrl).toMatch(/\/g\/[A-Za-z0-9_-]{20,}$/);
    expect(r.body.inviteUrl).not.toBe(inv.body.inviteUrl);
    expect(sentCount()).toBe(before); // no email
    const old = new Client(ctx.app);
    expect((await old.post("/api/guest/accept", { token: (inv.body.inviteUrl as string).split("/g/")[1] })).status).toBe(404);
    const g = new Client(ctx.app);
    expect((await g.post("/api/guest/accept", { token: (r.body.inviteUrl as string).split("/g/")[1] })).status).toBe(200);
    // Joined: no link needed any more.
    const again = await c.post(`/api/guests/${inv.body.guest.id}/link`, {});
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_joined");
  });

  it("refuses a removed guest, another workspace's guest, and a signed out caller", async () => {
    const p = await project();
    const inv = await c.post("/api/guests", { projectId: p.id, email: "mia@harbour.coffee" });
    const other = new Client(ctx.app);
    await other.signup();
    expect((await other.post(`/api/guests/${inv.body.guest.id}/link`, {})).status).toBe(404);
    expect((await new Client(ctx.app).post(`/api/guests/${inv.body.guest.id}/link`, {})).status).toBe(401);
    expect((await c.del(`/api/guests/${inv.body.guest.id}`)).status).toBe(200);
    expect((await c.post(`/api/guests/${inv.body.guest.id}/link`, {})).status).toBe(404);
  });
});
