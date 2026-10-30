import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { deliveries, domains, mailboxes, messages } from "@/server/db/schema";
import { deliverInbound } from "@/server/services/mail/delivery";
import { operatorInbox } from "@/server/config";
import { assertDomainAllowed, operatorDecision } from "@/server/services/suite/operator-inbox";
import { recheckStaleDomains, verifyDomain } from "@/server/services/domains";
import { copyFor, deliver, type Env } from "../email-worker/src/index";
import { newId } from "@/server/lib/crypto";

/**
 * Round 26 (DF-18, MB-83): support@ and security@multies.si land in a shared inbox of the operator
 * workspace. Other multies.si addresses stay closed, other domains route as before, and no other
 * workspace can claim the company domain or its addresses.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let op: Client;
let other: Client;
let opOrg: string;
let otherOrg: string;

const cfg = (orgId: string | null, addresses?: string) => ({ operatorInbox: operatorInbox("support@multies.si", orgId ?? undefined, addresses) });

async function inbound(to: string, extra: { requireOrgId?: string } = {}) {
  const subject = `Help ${Math.random().toString(36).slice(2, 6)}`;
  return deliverInbound(ctx.deps, {
    envelopeFrom: "pat@gmail.com", rcptTo: to, sizeBytes: 400, via: "test", ...extra,
    email: { messageId: `<${newId("x")}@gmail.com>`, from: { address: "pat@gmail.com", name: "Pat" }, to: [{ address: to }], cc: [], subject, text: "I need help", date: new Date(), attachments: [], authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {} },
  });
}

beforeEach(async () => {
  ctx = await makeTestApp({ SUPPORT_EMAIL: "support@multies.si" });
  op = new Client(ctx.app);
  await op.signup("ops@fintex.test", "Ops", "Multies HQ");
  opOrg = (await op.get("/api/account/me")).body.organization.id;
  other = new Client(ctx.app);
  await other.signup("eve@acme.test", "Eve", "Acme");
  otherOrg = (await other.get("/api/account/me")).body.organization.id;
  Object.assign(ctx.deps.config.operatorInbox, cfg(opOrg).operatorInbox);
});

describe("the routing decision", () => {
  it("reads the company domain from SUPPORT_EMAIL and lists support@ and security@ by default", () => {
    expect(operatorInbox("support@multies.si", "org_hq", undefined)).toEqual({ orgId: "org_hq", domain: "multies.si", addresses: ["support@multies.si", "security@multies.si"] });
    expect(operatorInbox("support@multies.si", " ", "Support@multies.si, hello@multies.si, x@evil.test").addresses).toEqual(["support@multies.si", "hello@multies.si"]);
    expect(operatorInbox("support@multies.si", undefined, undefined).orgId).toBeNull();
  });

  it("operator addresses go to the operator workspace, other company addresses are closed, other domains unchanged", () => {
    const c = cfg("org_hq");
    expect(operatorDecision(c, "Support@Multies.si")).toEqual({ kind: "operator", orgId: "org_hq", address: "support@multies.si" });
    expect(operatorDecision(c, "security@multies.si")).toMatchObject({ kind: "operator" });
    expect(operatorDecision(c, "hello@multies.si")).toEqual({ kind: "closed", address: "hello@multies.si" });
    expect(operatorDecision(c, "ada.acme@mail.multies.si")).toBeNull();
    expect(operatorDecision(c, "support@acme.io")).toBeNull();
    expect(operatorDecision(c, "support@notmulties.si")).toBeNull();
    // Without an operator workspace nothing changes.
    expect(operatorDecision(cfg(null), "support@multies.si")).toBeNull();
  });

  it("only the operator workspace may hold the company domain", () => {
    expect(() => assertDomainAllowed(cfg("org_hq"), "org_hq", "multies.si")).not.toThrow();
    expect(() => assertDomainAllowed(cfg("org_hq"), "org_x", "Multies.si")).toThrow(/reserved/);
    expect(() => assertDomainAllowed(cfg(null), "org_x", "multies.si")).toThrow(/reserved/);
    expect(() => assertDomainAllowed(cfg("org_hq"), "org_x", "mail.multies.si")).not.toThrow();
  });
});

describe("delivery into the operator's shared inbox", () => {
  async function setUp() {
    const res = await op.post("/api/domains", { name: "multies.si" });
    expect(res.status).toBe(201);
    const domainId = res.body.domain.id as string;
    for (const l of ["support", "security"]) expect((await op.post("/api/mailboxes", { domainId, localPart: l, displayName: l })).status).toBe(201);
    return domainId;
  }

  it("the company domain is not a plan add-on for the operator workspace, other domains still are", async () => {
    ctx.deps.fetch = (async () => new Response("{}")) as unknown as typeof fetch;
    // The operator workspace already uses its one included domain (Haajir HQ holds haajir.xyz).
    expect((await op.post("/api/domains", { name: "haajir.test" })).status).toBe(201);
    expect((await op.post("/api/domains", { name: "second.test" })).body.error.code).toBe("plan_limit");
    const res = await op.post("/api/domains", { name: "multies.si" });
    expect(res.status).toBe(201);
    expect(res.body.domain.status).toBe("verified");
    // support@ and security@ don't use up the plan's mailboxes; any other address on it does.
    const domainId = res.body.domain.id as string;
    for (const l of ["a", "b", "c"]) await op.post("/api/mailboxes", { domainId: (await op.get("/api/domains")).body.domains.find((d: { name: string }) => d.name === "haajir.test").id, localPart: l, displayName: l });
    for (const l of ["support", "security"]) expect((await op.post("/api/mailboxes", { domainId, localPart: l, displayName: l })).status).toBe(201);
    expect((await op.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "hello" })).body.error.code).toBe("plan_limit");
    // Another workspace is refused for the reservation, not offered the add-on.
    expect((await other.post("/api/domains", { name: "multies.si" })).status).toBe(409);
  });

  it("inbound keys can be made, listed and revoked with a workspace key (v1), never by a read only key", async () => {
    const v1 = async (key: string, method: string, path: string) => {
      const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json" } });
      return { status: res.status, body: await res.json() };
    };
    const ro = (await op.post("/api/developer/keys", { name: "Reader", scope: "read" })).body.secret as string;
    const full = (await op.post("/api/developer/keys", { name: "Full" })).body.secret as string;
    const otherKey = (await other.post("/api/developer/keys", { name: "Other" })).body.secret as string;
    expect((await v1(ro, "POST", "/inbound-keys")).status).toBe(403);
    const made = await v1(full, "POST", "/inbound-keys");
    expect(made.status).toBe(201);
    expect(made.body.key.secret).toMatch(/^whsec_/);
    expect(made.body.webhookUrl).toContain("/api/inbound/cloudflare");
    const list = await v1(full, "GET", "/inbound-keys");
    expect(list.body.keys.map((k: { id: string }) => k.id)).toEqual([made.body.key.id]);
    expect(JSON.stringify(list.body)).not.toContain(made.body.key.secret);
    expect((await v1(otherKey, "DELETE", `/inbound-keys/${made.body.key.id}`)).status).toBe(404);
    expect((await v1(full, "DELETE", `/inbound-keys/${made.body.key.id}`)).status).toBe(200);
    expect((await v1(full, "GET", "/inbound-keys")).body.keys).toEqual([]);
  });

  it("adds the company domain verified with no provider call, and support@ and security@ receive", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    ctx.deps.fetch = fetchSpy as unknown as typeof fetch;
    const domainId = await setUp();
    const row = (await ctx.db.select().from(domains).where(eq(domains.id, domainId)).get())!;
    expect(row).toMatchObject({ orgId: opOrg, status: "verified", providerStatus: "verified", providerDomainId: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const to of ["support@multies.si", "SECURITY@multies.si"]) {
      const r = await inbound(to, { requireOrgId: opOrg });
      expect(r).toMatchObject({ accepted: true, code: 250 });
      const mb = (await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, r.storedIn[0]!)).get())!;
      expect(mb.orgId).toBe(opOrg);
      expect(mb.address).toBe(to.toLowerCase());
    }
    // The shared inbox shows both threads to the operator team, and assignment works as for any thread.
    const threads = (await op.get("/api/agents/threads?view=all")).body.data as { id: string }[];
    expect(threads).toHaveLength(2);
    expect((await other.get("/api/agents/threads?view=all")).body.data).toHaveLength(0);
  });

  it("other company addresses are refused with nothing written, and a key from another workspace can't deliver", async () => {
    await setUp();
    const before = (await ctx.db.select().from(deliveries)).length;
    expect(await inbound("hello@multies.si")).toMatchObject({ accepted: false, code: 550 });
    expect(await inbound("random@multies.si", { requireOrgId: opOrg })).toMatchObject({ accepted: false, code: 550 });
    expect((await ctx.db.select().from(deliveries)).length).toBe(before);
    expect(await inbound("support@multies.si", { requireOrgId: otherOrg })).toMatchObject({ accepted: false, code: 550 });
    expect(await ctx.db.select().from(messages).where(eq(messages.orgId, opOrg))).toHaveLength(0);
  });

  it("another workspace can't add the domain, and a row it held before is never delivered to", async () => {
    expect((await other.post("/api/domains", { name: "multies.si" })).status).toBe(409);
    expect((await other.post("/api/domains", { name: "MULTIES.SI" })).status).toBe(409);
    // An old row in another workspace (made before this rule) with its own support@ mailbox.
    const domainId = newId("dom");
    await ctx.db.insert(domains).values({ id: domainId, orgId: otherOrg, name: "multies.si", verificationToken: "t", dkimSelector: "s", dkimPublicKey: "k", dkimPrivateKeyEnc: "e", status: "verified" });
    await ctx.db.insert(mailboxes).values({ id: newId("mbx"), orgId: otherOrg, domainId, localPart: "support", address: "support@multies.si", displayName: "Support", quotaMb: 1024 });
    expect(await inbound("support@multies.si")).toMatchObject({ accepted: false, code: 550 });
    expect(await inbound("support@multies.si", { requireOrgId: otherOrg })).toMatchObject({ accepted: false, code: 550 });
    expect(await ctx.db.select().from(messages).where(eq(messages.orgId, otherOrg))).toHaveLength(0);
    // The operator can't add it while the old row holds it; the runbook moves the row first.
    expect((await op.post("/api/domains", { name: "multies.si" })).status).toBe(409);
  });

  it("other domains keep routing as before, with or without an operator workspace", async () => {
    const domainId = (await other.post("/api/domains", { name: "acme.test" })).body.domain.id as string;
    await other.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" });
    expect(await inbound("support@acme.test")).toMatchObject({ accepted: true });
    Object.assign(ctx.deps.config.operatorInbox, cfg(null).operatorInbox);
    expect(await inbound("support@acme.test")).toMatchObject({ accepted: true });
    expect(await ctx.db.select().from(messages).where(and(eq(messages.orgId, otherOrg), eq(messages.folder, "inbox")))).toHaveLength(2);
  });

  it("the DNS check never demotes the company domain, and the scheduled check skips it", async () => {
    const domainId = await setUp();
    const row = (await ctx.db.select().from(domains).where(eq(domains.id, domainId)).get())!;
    expect((await verifyDomain(ctx.deps, row)).status).toBe("verified");
    expect((await ctx.db.select().from(domains).where(eq(domains.id, domainId)).get())!.status).toBe("verified");
    const checked = await recheckStaleDomains(ctx.deps, 0);
    expect(checked.map((c) => c.id)).not.toContain(domainId);
  });
});

describe("the email worker keeps a copy for the person who had the forward", () => {
  const base: Env = { MYMAIL_WEBHOOK_URL: "https://h/api/inbound/cloudflare", MYMAIL_KEY_ID: "ink_1", MYMAIL_KEY_SECRET: "s1", MYMAIL_COPY_TO: JSON.stringify({ "support@multies.si": "person@example.com" }) };
  const message = (to: string) => ({
    from: "pat@gmail.com", to, rawSize: 3, raw: new Response("abc").body!, setReject: vi.fn(), forward: vi.fn(async () => {}),
  });
  const answer = (action: string) => (async () => new Response(JSON.stringify({ action }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

  it("copies only after Multies accepted, only for listed addresses", async () => {
    expect(copyFor(base, "Support@Multies.si")).toBe("person@example.com");
    expect(copyFor(base, "security@multies.si")).toBeNull();
    expect(copyFor({ ...base, MYMAIL_COPY_TO: "{" }, "support@multies.si")).toBeNull();
    const m = message("support@multies.si");
    await deliver(m, base, answer("accept"));
    expect(m.forward).toHaveBeenCalledWith("person@example.com");
    const r = message("support@multies.si");
    await deliver(r, base, answer("reject"));
    expect(r.forward).not.toHaveBeenCalled();
    expect(r.setReject).toHaveBeenCalled();
    const s = message("security@multies.si");
    await deliver(s, base, answer("accept"));
    expect(s.forward).not.toHaveBeenCalled();
  });

  it("a failed copy doesn't bounce the original", async () => {
    const m = { ...message("support@multies.si"), forward: vi.fn(async () => { throw new Error("not verified"); }) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await deliver(m, base, answer("accept"));
    expect(m.setReject).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
