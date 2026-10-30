import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { messages, organizations } from "@/server/db/schema";
import { endOfDayIn, sprintDate, startOfDayIn, todayIn, zoneOffsetMinutes } from "@/server/services/suite/sprint-dates";
import { AUTH_HOOK_SETUP } from "@/server/routes/v1-auth-hooks";

/** Round 25: the cheap bugs Haajir found while running its company on Multies (MB-52 to MB-62). */
type Ctx = Awaited<ReturnType<typeof makeTestApp>>;
let ctx: Ctx;
let owner: Client;
let key: string;
let orgId: string;

async function api(k: string | null, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(path.startsWith("/") && !path.startsWith("/api") && !path.startsWith("/health") ? `/api/v1${path}` : path, { method, headers: { host: "localhost", ...(k ? { authorization: `Bearer ${k}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, type: res.headers.get("content-type") ?? "" };
}

async function verifiedDomain(c: Client, name: string) {
  const domainId = (await c.post("/api/domains", { name })).body.domain.id;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  expect((await c.post(`/api/domains/${domainId}/verify`)).body.domain.status).toBe("verified");
  return domainId as string;
}

beforeEach(async () => {
  ctx = await makeTestApp();
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  await ctx.db.update(organizations).set({ timezone: "Australia/Sydney" }).where(eq(organizations.id, orgId));
  key = (await owner.post("/api/developer/keys", { name: "rw" })).body.secret;
});

describe("sprint dates (pure)", () => {
  it("a date only start or end is that day in the zone, across daylight saving", () => {
    expect(zoneOffsetMinutes(new Date("2026-10-26T00:00:00Z"), "Australia/Sydney")).toBe(660);
    expect(zoneOffsetMinutes(new Date("2026-06-01T00:00:00Z"), "Australia/Sydney")).toBe(600);
    expect(startOfDayIn("2026-10-26", "Australia/Sydney").toISOString()).toBe("2026-10-25T13:00:00.000Z");
    expect(endOfDayIn("2026-11-01", "Australia/Sydney").toISOString()).toBe("2026-11-01T12:59:59.999Z");
    // Sydney moves to daylight time on 4 Oct 2026: that day is 23 hours long.
    expect(endOfDayIn("2026-10-04", "Australia/Sydney").getTime() - startOfDayIn("2026-10-04", "Australia/Sydney").getTime()).toBe(23 * 3_600_000 - 1);
    expect(startOfDayIn("2026-10-26", "UTC").toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(todayIn(new Date("2026-10-25T22:00:00Z"), "Australia/Sydney")).toBe("2026-10-26");
    expect(sprintDate("2026-10-26T05:00:00.000Z", "end", "Australia/Sydney")!.toISOString()).toBe("2026-10-26T05:00:00.000Z");
    expect(sprintDate("", "start", "UTC")).toBeNull();
    expect(sprintDate(undefined, "start", "UTC")).toBeNull();
  });
});

describe("MB-53: /health", () => {
  it("answers the same JSON on /health, /healthz and /api/health, never the HTML page", async () => {
    for (const path of ["/health", "/healthz", "/api/health"]) {
      const r = await api(null, "GET", path);
      expect(r.status).toBe(200);
      expect(r.type).toContain("application/json");
      expect(r.body).toMatchObject({ ok: true, db: "ok" });
    }
  });
});

describe("MB-54, MB-55, MB-62: sprints", () => {
  it("takes startDate and endDate, reads date only values as workspace days, and gives each sprint a link", async () => {
    const projectId = (await owner.post("/api/projects", { name: "Build" })).body.project.id as string;
    const made = await api(key, "POST", `/projects/${projectId}/sprints`, { name: "S1", startDate: "2026-10-26", endDate: "2026-11-01" });
    expect(made.status).toBe(201);
    expect(made.body.sprint).toMatchObject({ startAt: "2026-10-25T13:00:00.000Z", endAt: "2026-11-01T12:59:59.999Z" });
    expect(made.body.sprint.url).toMatch(/\/app\/tasks\?project=.+&view=sprints&sprint=spr_/);

    // PATCH with a date only end keeps the whole last day, the same as create.
    const patched = await api(key, "PATCH", `/sprints/${made.body.sprint.id}`, { endAt: "2026-11-02" });
    expect(patched.status).toBe(200);
    expect(patched.body.sprint.endAt).toBe("2026-11-02T12:59:59.999Z");
    const aliased = await api(key, "PATCH", `/sprints/${made.body.sprint.id}`, { endDate: "2026-11-03" });
    expect(aliased.body.sprint.endAt).toBe("2026-11-03T12:59:59.999Z");

    // The next sprint with no dates starts the day after, at Sydney midnight, and runs 14 days.
    const next = await api(key, "POST", `/projects/${projectId}/sprints`, {});
    expect(next.body.sprint).toMatchObject({ startAt: "2026-11-03T13:00:00.000Z", endAt: "2026-11-17T12:59:59.999Z" });
    const listed = await api(key, "GET", `/projects/${projectId}/sprints`);
    expect(listed.body.sprints.every((s: { url?: string }) => typeof s.url === "string")).toBe(true);
    const one = await api(key, "GET", `/sprints/${made.body.sprint.id}`);
    expect(one.body.sprint.url).toContain(`sprint=${made.body.sprint.id}`);
  });
});

describe("MB-52 and MB-56: task lists and epic items", () => {
  it("lists a project's tasks at /projects/{id}/tasks and refuses another workspace's project", async () => {
    const projectId = (await owner.post("/api/projects", { name: "Build" })).body.project.id as string;
    const other = (await owner.post("/api/projects", { name: "Other" })).body.project.id as string;
    await api(key, "POST", "/tasks", { title: "In build", projectId });
    await api(key, "POST", "/tasks", { title: "Elsewhere", projectId: other });
    const r = await api(key, "GET", `/projects/${projectId}/tasks`);
    expect(r.status).toBe(200);
    expect(r.body.tasks.map((t: { title: string }) => t.title)).toEqual(["In build"]);

    const stranger = new Client(ctx.app);
    await stranger.signup("x@other.io", "Xena Other");
    const theirKey = (await stranger.post("/api/developer/keys", { name: "k" })).body.secret;
    const theirs = await api(theirKey, "GET", `/projects/${projectId}/tasks`);
    expect(theirs.status).toBe(404);
  });

  it("adds epic items with ids or taskIds, and says which field is missing", async () => {
    const projectId = (await owner.post("/api/projects", { name: "Build" })).body.project.id as string;
    const epic = (await api(key, "POST", "/tasks", { title: "Epic", projectId, type: "epic" })).body.task;
    const a = (await api(key, "POST", "/tasks", { title: "A", projectId })).body.task;
    const b = (await api(key, "POST", "/tasks", { title: "B", projectId })).body.task;
    expect((await api(key, "POST", `/epics/${epic.id}/items`, { taskIds: [a.id] })).status).toBe(200);
    expect((await api(key, "POST", `/epics/${epic.id}/items`, { ids: [b.id] })).status).toBe(200);
    const bad = await api(key, "POST", `/epics/${epic.id}/items`, {});
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body)).toContain("taskIds");
    expect((await api(key, "DELETE", `/epics/${epic.id}/items`, { taskIds: [a.id] })).status).toBe(200);
  });
});

describe("MB-58: docs update from plain text", () => {
  it("PATCH /docs/{id} with text replaces the body using the create rules", async () => {
    const doc = (await api(key, "POST", "/docs", { title: "Notes", text: "old" })).body.doc;
    const r = await api(key, "PATCH", `/docs/${doc.id}`, { text: "# Agenda\n- one\n- two" });
    expect(r.status).toBe(200);
    const read = await api(key, "GET", `/docs/${doc.id}`);
    expect(read.body.doc.plainText ?? read.body.doc.text).toContain("Agenda");
    expect(JSON.stringify(read.body.doc.content)).toContain("heading");
    expect(JSON.stringify(read.body.doc.content)).toContain("bulletList");
    expect(JSON.stringify(read.body.doc.content)).not.toContain("old");
  });
});

describe("MB-59 and MB-61: threads and sending", () => {
  it("PATCH /threads/{id} sets status and owner in one call; empty bodies and unknown threads are refused", async () => {
    const domainId = await verifiedDomain(owner, "acme.io");
    const box = (await owner.post("/api/mailboxes", { domainId, localPart: "support", displayName: "Support" })).body.mailbox;
    const me = (await owner.get("/api/account/me")).body.user.id as string;
    await ctx.db.insert(messages).values({ id: "msg_r25a", orgId, mailboxId: box.id, folder: "inbox", threadId: "thr_r25", fromAddress: "c@example.com", fromName: "C", subject: "Help", snippet: "hi", date: new Date() });
    const r = await api(key, "PATCH", "/threads/thr_r25", { status: "done", userId: me });
    expect(r.status).toBe(200);
    expect(r.body.state).toMatchObject({ status: "done" });
    expect(r.body.state.assignee?.id ?? r.body.state.assigneeUserId).toBe(me);
    expect((await api(key, "PATCH", "/threads/thr_r25", { status: "open", assigneeId: null })).body.state.status).toBe("open");
    expect((await api(key, "PATCH", "/threads/thr_r25", {})).status).toBe(422);
    expect((await api(key, "PATCH", "/threads/thr_nope", { status: "done" })).status).toBe(404);
  });

  it("POST /messages carries replyTo to the outgoing mail and the Sent copy", async () => {
    const domainId = await verifiedDomain(owner, "acme.io");
    await owner.post("/api/mailboxes", { domainId, localPart: "no-reply", displayName: "Acme" });
    const r = await api(key, "POST", "/messages", { from: "no-reply@acme.io", to: ["parent@example.com"], subject: "Absent today", text: "Reply to stop.", replyTo: "support@acme.io" });
    expect(r.status).toBe(200);
    const sent = ctx.outbound.sent.at(-1)!;
    expect(sent.replyTo).toBe("support@acme.io");
    const row = await ctx.db.select({ replyTo: messages.replyTo }).from(messages).where(eq(messages.id, r.body.messageId)).get();
    expect(row?.replyTo).toBe("support@acme.io");
    expect((await api(key, "POST", "/messages", { from: "no-reply@acme.io", to: ["p@example.com"], text: "x", replyTo: "not an address" })).status).toBe(422);
  });
});

describe("MB-57: auth email hook setup", () => {
  it("names the Supabase rate limit step that otherwise drops signups", () => {
    const all = AUTH_HOOK_SETUP.join(" ");
    expect(all).toContain("SMTP");
    expect(all).toContain("2 auth emails an hour");
    expect(all).toContain("Rate Limits");
  });
});
