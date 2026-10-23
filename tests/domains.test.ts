import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });

async function publishAll(dns: typeof ctx.dns, domain: { name: string; records: { id: string; value: string; values?: { value: string; priority: number }[]; fqdn: string }[] }) {
  for (const r of domain.records) {
    if (r.id === "mx") dns.records.mx = { ...dns.records.mx, [r.fqdn]: r.values!.map((v) => ({ exchange: v.value, priority: v.priority })) };
    else dns.records.txt = { ...dns.records.txt, [r.fqdn]: [...(dns.records.txt?.[r.fqdn] ?? []), r.value] };
  }
}

describe("domains API", () => {
  it("adds a domain with its own DKIM key and setup records", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const r = await c.post("/api/domains", { name: "Acme.IO" });
    expect(r.status).toBe(201);
    expect(r.body.domain.name).toBe("acme.io");
    expect(r.body.domain.status).toBe("pending");
    const dkim = r.body.domain.records.find((x: { id: string }) => x.id === "dkim");
    expect(dkim.value).toMatch(/^v=DKIM1; k=rsa; p=MIIBIjAN/);
    expect(JSON.stringify(r.body)).not.toContain("PRIVATE KEY");
    const row = await ctx.db.query.domains.findFirst();
    expect(row!.dkimPrivateKeyEnc.startsWith("v1:")).toBe(true);
  });

  it("verifies once DNS is published, and audits it", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    const { body } = await c.post("/api/domains", { name: "acme.io" });
    await publishAll(ctx.dns, body.domain);
    const v = await c.post(`/api/domains/${body.domain.id}/verify`);
    expect(v.body.report.verified).toBe(true);
    expect(v.body.domain.status).toBe("verified");
    const audit = await ctx.db.query.auditLogs.findMany();
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["domain.added", "domain.verified"]));
  });

  it("enforces the plan's domain limit server-side", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    expect((await c.post("/api/domains", { name: "one.io" })).status).toBe(201);
    const second = await c.post("/api/domains", { name: "two.io" });
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe("plan_limit");
  });

  it("isolates tenants", async () => {
    const a = new Client(ctx.app);
    const b = new Client(ctx.app);
    await a.signup();
    await b.signup();
    const { body } = await a.post("/api/domains", { name: "private.io" });
    expect((await b.get(`/api/domains/${body.domain.id}`)).status).toBe(404);
    expect((await b.del(`/api/domains/${body.domain.id}`)).status).toBe(404);
    expect((await b.get("/api/domains")).body.domains).toHaveLength(0);
    expect((await b.post("/api/domains", { name: "private.io" })).status).toBe(409);
  });

  it("rejects malformed domains", async () => {
    const c = new Client(ctx.app);
    await c.signup();
    for (const name of ["localhost", "-bad.com", "a..b.com", "1.2.3.4"]) {
      expect((await c.post("/api/domains", { name })).status).toBe(422);
    }
  });
});
