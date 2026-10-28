import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { idempotencyKeys } from "@/server/db/schema";

/**
 * R52 (MB-239): a create whose first attempt committed but answered 5xx (or was cut off) is retried with the same
 * Idempotency-Key: the retry returns the same id and the table still holds exactly one row for it. The 5xx is
 * simulated the way R40 did it: the first call succeeds, then its key row is set back to running with a 503.
 */
type Case = { name: string; table: string; path: (s: Seed) => string; body: (s: Seed) => unknown; pick: (j: Record<string, unknown>) => string[] };
type Seed = { project: string; task: string };
const startsAt = new Date(Date.now() + 86_400_000).toISOString();
const one = (k: string) => (j: Record<string, unknown>) => [(j[k] as { id: string }).id];
const cases: Case[] = [
  { name: "doc", table: "docs", path: () => "/docs", body: () => ({ title: "Retry doc" }), pick: one("doc") },
  { name: "deal", table: "deals", path: () => "/deals", body: () => ({ title: "Retry deal" }), pick: one("deal") },
  { name: "meeting", table: "meetings", path: () => "/meetings", body: () => ({ title: "Retry meeting", startsAt }), pick: one("meeting") },
  { name: "task comment", table: "task_comments", path: (s) => `/tasks/${s.task}/comments`, body: () => ({ body: "Retry comment" }), pick: one("comment") },
  { name: "form", table: "forms", path: () => "/forms", body: () => ({ name: "Retry form" }), pick: one("form") },
  { name: "goal", table: "goals", path: () => "/goals", body: () => ({ name: "Retry goal" }), pick: one("goal") },
  { name: "time entry", table: "time_entries", path: () => "/time", body: (s) => ({ minutes: 30, taskId: s.task }), pick: one("entry") },
  { name: "chat channel", table: "chat_channels", path: () => "/chat/channels", body: () => ({ name: "retry-channel" }), pick: one("channel") },
  { name: "agent", table: "agents", path: () => "/agents", body: () => ({ name: "Retry bot", localPart: "retrybot" }), pick: one("agent") },
  { name: "snippet", table: "mail_snippets", path: () => "/snippets", body: () => ({ name: "Retry reply", body: "Hello", shortcut: "retryreply" }), pick: one("snippet") },
  { name: "custom field", table: "custom_fields", path: (s) => `/projects/${s.project}/fields`, body: () => ({ name: "Retry field", type: "text" }), pick: one("field") },
  { name: "checklist items", table: "task_checklist_items", path: (s) => `/tasks/${s.task}/checklist`, body: () => ({ items: [{ title: "One" }, { title: "Two" }] }),
    pick: (j) => (j.items as { id: string }[]).map((x) => x.id) },
  { name: "sprint", table: "sprints", path: (s) => `/projects/${s.project}/sprints`, body: () => ({ name: "Retry sprint" }), pick: one("sprint") },
];

describe("v1 create retried after a 5xx keeps the same id (R52 MB-239)", () => {
  it.each(cases)("$name: the retry returns the same id and makes no second row", async (k) => {
    const t = await makeTestApp();
    const c = new Client(t.app);
    await c.signup("owner.r52@acme.io", "Olive Owner");
    const secret = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
    const v1 = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
      const r = await t.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const project = ((await v1("POST", "/projects", { name: "Seed" })).json.project as { id: string }).id;
    const task = ((await v1("POST", "/tasks", { title: "Seed", projectId: project })).json.task as { id: string }).id;
    const s = { project, task };
    if (k.name === "agent") expect((await v1("POST", "/domains", { name: "retry-r52.io" })).status).toBe(201); // an agent inbox needs a domain
    const db = t.db as unknown as { all: (q: unknown) => { n: number }[]; update: typeof t.db.update };
    const count = () => db.all(sql.raw(`select count(*) as n from "${k.table}"`))[0]!.n;
    const key = { "idempotency-key": `r52-retry-${k.name.replace(/\W/g, "")}-0001` };
    const first = await v1("POST", k.path(s), k.body(s), key);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const ids = k.pick(first.json);
    const rows = count();
    // The first attempt committed, then answered 503: the key row is retryable.
    await t.db.update(idempotencyKeys).set({ state: "running", responseStatus: 503, responseBody: null }).where(eq(idempotencyKeys.key, key["idempotency-key"]));
    const retry = await v1("POST", k.path(s), k.body(s), key);
    expect(retry.status, JSON.stringify(retry.json)).toBe(201);
    expect(k.pick(retry.json)).toEqual(ids);
    expect(count()).toBe(rows);
    // And the retry's answer is now stored: a third call replays it.
    const third = await v1("POST", k.path(s), k.body(s), key);
    expect(k.pick(third.json)).toEqual(ids);
    expect(count()).toBe(rows);
  }, 60_000);

  it("without a key nothing changes: two calls make two rows", async () => {
    const t = await makeTestApp();
    const c = new Client(t.app);
    await c.signup("owner2.r52@acme.io", "Olive Owner");
    const secret = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
    const post = async () => (await t.app.request("/api/v1/goals", { method: "POST", headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Twice" }) })).json() as Promise<{ goal: { id: string } }>;
    const a = await post(); const b = await post();
    expect(a.goal.id).not.toBe(b.goal.id);
  });
});
