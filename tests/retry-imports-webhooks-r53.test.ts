import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { dataMoves, idempotencyKeys } from "@/server/db/schema";

/**
 * R53 (MB-239): imports and webhook endpoint creation retried after a 5xx under the same Idempotency-Key. A first
 * attempt that committed (fully, or only part of the way) and then answered 503 is retried; the retry leaves one
 * copy of every row and answers with the same ids. The 503 is simulated as R40 and R52 did (the key row is set back
 * to running with a 503); a cut off first attempt is simulated by undoing what it would not have reached.
 */
async function setup() {
  const t = await makeTestApp();
  const c = new Client(t.app);
  await c.signup("owner.r53imp@acme.io", "Olive Owner");
  const secret = (await c.post("/api/developer/keys", { name: "rw" })).body.secret as string;
  const v1 = async (method: string, path: string, body?: unknown, key?: string) => {
    const r = await t.app.request(`/api/v1${path}`, { method, headers: { host: "localhost", authorization: `Bearer ${secret}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const db = t.db as unknown as { all: (q: unknown) => { n: number }[]; run: (q: unknown) => unknown };
  const count = (table: string) => db.all(sql.raw(`select count(*) as n from "${table}"`))[0]!.n;
  const fail = (key: string) => t.db.update(idempotencyKeys).set({ state: "running", responseStatus: 503, responseBody: null }).where(eq(idempotencyKeys.key, key));
  const client = (t.db as unknown as { $client: { prepare: (q: string) => Record<string, (...a: unknown[]) => unknown> } }).$client;
  const prepare = client.prepare.bind(client);
  let log: string[] | null = null;
  client.prepare = (q: string) => {
    const st = prepare(q);
    for (const fn of ["run", "all", "get", "raw", "values"]) {
      if (typeof st[fn] !== "function") continue;
      const orig = st[fn].bind(st);
      st[fn] = (...a: unknown[]) => { log?.push(q); return orig(...a); };
    }
    return st;
  };
  const measure = async <T>(fn: () => Promise<T>) => { log = []; const r = await fn(); const statements = log; log = null; return { r, statements }; };
  return { t, v1, db, count, fail, measure };
}
const app = (s: string[]) => s.filter((q) => !/idempotency_keys/i.test(q));
const csv = (tag: string) => `Title,Status,Description\n${tag} one,Done,First\n${tag} two,To do,Second\n${tag} three,To do,Third\n`;

describe("work import run retried after a 5xx (R53 MB-239)", () => {
  it("a retry after a committed run leaves one copy of every task and the same project", async () => {
    const s = await setup();
    const key = "r53-workimport-0001";
    const first = await s.v1("POST", "/work-imports/run", { fileName: "plan.csv", content: csv("A"), projectName: "R53 plan" }, key);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.created).toBe(3);
    const counts = { tasks: s.count("tasks"), projects: s.count("projects") };
    await s.fail(key);
    const retry = await s.v1("POST", "/work-imports/run", { fileName: "plan.csv", content: csv("A"), projectName: "R53 plan" }, key);
    expect(retry.status).toBe(200);
    expect(retry.json.projectId).toBe(first.json.projectId);
    expect(retry.json.created).toBe(0);
    expect(retry.json.alreadyThere).toBe(3);
    expect({ tasks: s.count("tasks"), projects: s.count("projects") }).toEqual(counts);
  }, 60_000);

  it("a first attempt cut off after the project but before any task: the retry fills that project, not a second one", async () => {
    const s = await setup();
    const key = "r53-workimport-0002";
    const first = await s.v1("POST", "/work-imports/run", { fileName: "cut.csv", content: csv("B"), projectName: "R53 cut" }, key);
    const projectId = first.json.projectId as string;
    const projects = s.count("projects");
    s.db.run(sql`delete from tasks where project_id = ${projectId}`); // the tasks batch never landed
    await s.fail(key);
    const retry = await s.v1("POST", "/work-imports/run", { fileName: "cut.csv", content: csv("B"), projectName: "R53 cut" }, key);
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect(retry.json.projectId).toBe(projectId);
    expect(retry.json.created).toBe(3);
    expect(s.count("projects")).toBe(projects);
  }, 60_000);

  it("without a key nothing changes: a second run of the same file still skips by import key", async () => {
    const s = await setup();
    const a = await s.v1("POST", "/work-imports/run", { fileName: "nokey.csv", content: csv("C"), projectName: "No key" });
    const n = s.count("tasks");
    const b = await s.v1("POST", "/work-imports/run", { fileName: "nokey.csv", content: csv("C"), projectName: "No key" });
    expect(b.json.projectId).toBe(a.json.projectId);
    expect(s.count("tasks")).toBe(n);
  }, 60_000);

  it("a keyed first run runs the same app statements as a run without a key", async () => {
    const s = await setup();
    await s.v1("POST", "/work-imports/run", { fileName: "w.csv", content: csv("W"), projectName: "Warm" }); // warm the read caches first
    const plain = await s.measure(() => s.v1("POST", "/work-imports/run", { fileName: "p.csv", content: csv("P"), projectName: "Plain" }));
    const keyed = await s.measure(() => s.v1("POST", "/work-imports/run", { fileName: "k.csv", content: csv("K"), projectName: "Keyed" }, "r53-workimport-count-1"));
    expect(app(keyed.statements).length).toBe(app(plain.statements).length);
    if (process.env.R53_COUNTS) console.log(`R53_COUNTS work-import plain=${plain.statements.length} keyed=${keyed.statements.length} keyed_app=${app(keyed.statements).length}`);
  }, 60_000);
});

describe("data move import run retried after a 5xx (R53 MB-239)", () => {
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:r53-a", "SUMMARY:Retry one", "DTSTART:20261201T090000Z", "DTEND:20261201T100000Z", "END:VEVENT",
    "BEGIN:VEVENT", "UID:r53-b", "SUMMARY:Retry two", "DTSTART:20261202T090000Z", "DTEND:20261202T100000Z", "END:VEVENT",
    "END:VCALENDAR", ""].join("\r\n");
  for (const kind of ["calendar", "docs"] as const) {
    const body = kind === "calendar" ? { kind, fileName: "r53.ics", content: ics } : { kind, fileName: "r53.md", content: "# Retry page\n\nHello there" };
    const table = kind === "calendar" ? "meetings" : "docs";
    it(`${kind}: a retry after a committed run keeps one run and one copy of every item`, async () => {
      const s = await setup();
      const key = `r53-move-${kind}-0001`;
      const first = await s.v1("POST", "/data-moves/imports/run", body, key);
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      const move = (first.json.move as { id: string }).id;
      const n = { items: s.count(table), moves: s.count("data_moves") };
      await s.fail(key);
      const retry = await s.v1("POST", "/data-moves/imports/run", body, key);
      expect((retry.json.move as { id: string }).id).toBe(move);
      expect({ items: s.count(table), moves: s.count("data_moves") }).toEqual(n);
    }, 60_000);

    it(`${kind}: a first attempt cut off before it saved its progress adds nothing on the retry`, async () => {
      const s = await setup();
      const key = `r53-move-${kind}-0002`;
      const first = await s.v1("POST", "/data-moves/imports/run", body, key);
      const move = (first.json.move as { id: string }).id;
      const n = { items: s.count(table), moves: s.count("data_moves") };
      expect(n.items).toBeGreaterThan(0);
      // The items went in, the progress update did not: the run row still says nothing is done.
      await s.t.db.update(dataMoves).set({ done: 0, created: "{}", status: "running", finishedAt: null }).where(eq(dataMoves.id, move));
      await s.fail(key);
      const retry = await s.v1("POST", "/data-moves/imports/run", body, key);
      expect(retry.status, JSON.stringify(retry.json)).toBe(200);
      expect((retry.json.move as { id: string; status: string }).id).toBe(move);
      expect({ items: s.count(table), moves: s.count("data_moves") }).toEqual(n);
    }, 60_000);
  }
});

describe("webhook endpoint creation retried after a 5xx (R53 MB-239)", () => {
  it("the retry returns the committed endpoint with the same id and the same secret, and no second row", async () => {
    const s = await setup();
    const key = "r53-webhook-0001";
    const body = { url: "https://example.com/hooks/r53", events: ["task.created"] };
    const first = await s.v1("POST", "/webhooks", body, key);
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const rows = s.count("webhook_endpoints");
    await s.fail(key);
    const retry = await s.v1("POST", "/webhooks", body, key);
    expect(retry.status).toBe(201);
    expect(retry.json.id).toBe(first.json.id);
    expect(retry.json.secret).toBe(first.json.secret); // the first answer never arrived, so this is its first showing; no second secret
    expect(s.count("webhook_endpoints")).toBe(rows);
  }, 60_000);

  it("without a key two calls make two endpoints with two secrets, and a keyed first call runs the same app statements", async () => {
    const s = await setup();
    const body = { url: "https://example.com/hooks/r53b", events: ["task.created"] };
    await s.v1("POST", "/webhooks", body); // warm the read caches first
    const plain = await s.measure(() => s.v1("POST", "/webhooks", body));
    const again = await s.v1("POST", "/webhooks", body);
    expect(again.json.id).not.toBe(plain.r.json.id);
    expect(again.json.secret).not.toBe(plain.r.json.secret);
    const keyed = await s.measure(() => s.v1("POST", "/webhooks", body, "r53-webhook-count-1"));
    expect(app(keyed.statements).length).toBe(app(plain.statements).length);
    if (process.env.R53_COUNTS) console.log(`R53_COUNTS webhook plain=${plain.statements.length} keyed=${keyed.statements.length} keyed_app=${app(keyed.statements).length}`);
  }, 60_000);
});
