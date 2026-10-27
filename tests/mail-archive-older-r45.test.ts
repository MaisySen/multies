import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { mailboxAccess, mailboxes, messages, users } from "@/server/db/schema";
import { previewBulkJob, runBulkJob } from "@/server/services/mail/bulk-job-r33";
import { takeEarlyRead } from "@/web/lib/api";

/**
 * R45 (MB-137) "Archive older mail": the count preview and the job only see mail dated before the chosen time, and only
 * in mailboxes the person can open (a member cannot preview or archive another member's mailbox). R45 (MB-203): the
 * early reads started by public/boot.js are taken once, and only while fresh.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mailboxId: string;
let orgId: string;
let now = new Date("2026-10-26T03:00:00Z");
const DAY = 86_400_000;

beforeEach(async () => {
  ctx = await makeTestApp();
  now = new Date("2026-10-26T03:00:00Z");
  ctx.deps.now = () => now;
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  await owner.post("/api/org/plan", { plan: "pro" });
  const domainId = (await owner.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const { body } = await owner.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await owner.post(`/api/domains/${domainId}/verify`);
  const mb = (await owner.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox;
  mailboxId = mb.id;
  orgId = (await ctx.deps.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get())!.orgId;
});



async function seedAged(days: number[]) {
  const rows = days.map((d, i) => ({ id: `msg_age_${i}`, orgId, mailboxId, folder: "inbox" as const, threadId: `thr_age_${i}`, fromAddress: `p${i}@example.com`, subject: `Aged ${i}`, date: new Date(now.getTime() - d * DAY), isRead: false }));
  for (let i = 0; i < rows.length; i += 3) await ctx.deps.db.insert(messages).values(rows.slice(i, i + 3));
}
const inFolder = async (folder: "inbox" | "archive") => (await ctx.deps.db.select({ id: messages.id }).from(messages).where(eq(messages.folder, folder)).all()).length;
const ceiling = () => new Date(Date.now() + 1000).toISOString();

describe("Archive older mail (R45, MB-137)", () => {
  it("previews and archives only mail dated before the cut, and one Undo puts it all back", async () => {
    await seedAged([1, 3, 10, 40, 40, 100, 400]);
    const before = new Date(now.getTime() - 30 * DAY).toISOString(); // older than 1 month
    const scope = { mailboxId, folder: "inbox", before };
    const p = await owner.post("/api/mail/bulk-jobs/preview", { scope, max_received_at: ceiling() });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ total: 4 });
    const job = await owner.post("/api/mail/bulk-jobs", { client_job_id: "older_than_1m_1", action: "archive", scope, max_received_at: ceiling() });
    expect(job.body).toMatchObject({ status: "done", total: 4, done: 4, undoable: true });
    expect(await inFolder("archive")).toBe(4);
    expect(await inFolder("inbox")).toBe(3);
    const u = await owner.post(`/api/mail/bulk-jobs/${job.body.id}/undo`);
    expect(u.body).toMatchObject({ status: "reverted", undoDone: 4 });
    expect(await inFolder("inbox")).toBe(7);
  });

  it("rejects a cut that is not a time", async () => {
    const r = await owner.post("/api/mail/bulk-jobs/preview", { scope: { mailboxId, folder: "inbox", before: "soon" }, max_received_at: ceiling() });
    expect(r.status).toBe(400);
  });

  it("a member cannot preview or archive a mailbox they were not given, and can once it is theirs", async () => {
    await seedAged([40, 50]);
    const memberId = "usr_r45_member";
    await ctx.deps.db.insert(users).values({ id: memberId, email: "member@acme.io", name: "Mo Member", emailVerified: true });
    const member = { orgId, userId: memberId, role: "member" as const };
    const scope = { mailboxId, folder: "inbox", before: new Date(now.getTime() - 30 * DAY).toISOString() };
    await expect(previewBulkJob(ctx.deps, member, { scope, maxReceivedAt: ceiling() })).rejects.toMatchObject({ status: 404 });
    await expect(runBulkJob(ctx.deps, member, { clientJobId: "member_try_1", action: "archive", scope, maxReceivedAt: ceiling() })).rejects.toMatchObject({ status: 404 });
    expect(await inFolder("archive")).toBe(0);
    await ctx.deps.db.insert(mailboxAccess).values({ orgId, userId: memberId, mailboxId });
    expect(await previewBulkJob(ctx.deps, member, { scope, maxReceivedAt: ceiling() })).toMatchObject({ total: 2 });
  });

  it("a mailbox in another workspace is not found", async () => {
    const other = (await ctx.deps.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).get())!;
    const outsider = { orgId: "org_someone_else", userId: "usr_x", role: "owner" as const };
    expect(await previewBulkJob(ctx.deps, outsider, { scope: { mailboxId: other.id, folder: "inbox" }, maxReceivedAt: ceiling() })).toMatchObject({ total: 0 });
  });
});

describe("early reads from the page (R45, MB-203)", () => {
  it("are taken once, only for the same path, and not after 30 s", async () => {
    const g = globalThis as { __mmEarly?: Record<string, { at: number; res: Promise<Response> }> };
    const res = Promise.resolve(new Response("{}"));
    g.__mmEarly = { "/account/me": { at: 1_000, res }, "/my-work": { at: 1_000, res } };
    expect(takeEarlyRead("/config", 2_000)).toBeNull();
    expect(takeEarlyRead("/account/me", 2_000)).toBe(res);
    expect(takeEarlyRead("/account/me", 2_000)).toBeNull();
    expect(takeEarlyRead("/my-work", 40_000)).toBeNull();
    expect(g.__mmEarly["/my-work"]).toBeUndefined();
    delete g.__mmEarly;
    expect(takeEarlyRead("/account/me")).toBeNull();
  });
});
