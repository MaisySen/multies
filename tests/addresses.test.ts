import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let domainId: string;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup();
  domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
});

describe("mailboxes", () => {
  it("creates, updates and deletes a mailbox", async () => {
    const r = await c.post("/api/mailboxes", { domainId, localPart: "Hello", displayName: "Hello Acme" });
    expect(r.status).toBe(201);
    expect(r.body.mailbox).toMatchObject({ address: "hello@acme.io", quotaMb: 3072, status: "active" });
    const id = r.body.mailbox.id;
    expect((await c.patch(`/api/mailboxes/${id}`, { displayName: "Support" })).body.mailbox.displayName).toBe("Support");
    expect((await c.patch(`/api/mailboxes/${id}`, { quotaMb: 999999 })).status).toBe(400);
    expect((await c.del(`/api/mailboxes/${id}`)).status).toBe(200);
    expect((await c.get("/api/mailboxes")).body.mailboxes).toHaveLength(0);
  });

  it("enforces the starter plan's 3 mailboxes, then lifts it on upgrade", async () => {
    for (const lp of ["a", "b", "c"]) expect((await c.post("/api/mailboxes", { domainId, localPart: lp, displayName: lp })).status).toBe(201);
    const fourth = await c.post("/api/mailboxes", { domainId, localPart: "d", displayName: "d" });
    expect(fourth.status).toBe(403);
    expect(fourth.body.error.code).toBe("plan_limit");
    expect((await c.post("/api/org/plan", { plan: "pro" })).status).toBe(200);
    expect((await c.post("/api/mailboxes", { domainId, localPart: "d", displayName: "d" })).status).toBe(201);
    const down = await c.post("/api/org/plan", { plan: "starter" });
    expect(down.status).toBe(400);
  });

  it("refuses duplicate addresses across mailboxes and aliases", async () => {
    await c.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" });
    expect((await c.post("/api/mailboxes", { domainId, localPart: "team", displayName: "Team" })).status).toBe(409);
    expect((await c.post("/api/aliases", { domainId, localPart: "team", destinations: ["x@y.com"] })).status).toBe(409);
  });

  it("rejects invalid local parts", async () => {
    for (const localPart of [".dot", "a..b", "spa ce", "x@y"]) {
      expect((await c.post("/api/mailboxes", { domainId, localPart, displayName: "x" })).status).toBe(422);
    }
  });

  it("cannot use another tenant's domain", async () => {
    const other = new Client(ctx.app);
    await other.signup();
    expect((await other.post("/api/mailboxes", { domainId, localPart: "x", displayName: "x" })).status).toBe(404);
  });
});

describe("aliases", () => {
  it("creates and edits forwarding aliases", async () => {
    const r = await c.post("/api/aliases", { domainId, localPart: "sales", destinations: ["Founder@Gmail.com", "founder@gmail.com", "ops@acme.io"] });
    expect(r.status).toBe(201);
    expect(r.body.alias.destinations).toEqual(["founder@gmail.com", "ops@acme.io"]);
    const u = await c.patch(`/api/aliases/${r.body.alias.id}`, { enabled: false });
    expect(u.body.alias.enabled).toBe(false);
    expect((await c.post("/api/aliases", { domainId, localPart: "loop", destinations: ["loop@acme.io"] })).status).toBe(400);
  });

  it("writes an audit trail for every change", async () => {
    const m = await c.post("/api/mailboxes", { domainId, localPart: "ceo", displayName: "CEO" });
    await c.del(`/api/mailboxes/${m.body.mailbox.id}`);
    const log = await c.get("/api/org/audit");
    expect(log.body.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(["account.created", "domain.added", "mailbox.created", "mailbox.deleted"]),
    );
  });
});
