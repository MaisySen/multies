import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client, d1Violations } from "./helpers";
import { parseTaskQuery, TaskQueryError, looksLikeQuery, QUERY_MAX_COST, suggest, type QueryNode } from "@/shared/task-query";

/** R34: OR, AND, NOT, brackets and history operators (WAS, CHANGED FROM TO AFTER BEFORE BY) in the task query. */
const shape = (n: QueryNode | undefined): unknown => {
  if (!n) return null;
  if (n.op === "term") return n.term.kind === "text" ? n.term.value : n.term.kind === "history" ? `${n.term.key} ${n.term.op}` : `${n.term.negate ? "-" : ""}${n.term.key}:${n.term.values.join(",")}`;
  if (n.op === "not") return ["not", shape(n.item)];
  return [n.op, ...n.items.map(shape)];
};
const err = (q: string) => { try { parseTaskQuery(q); return null; } catch (e) { return e instanceof TaskQueryError ? e.message : String(e); } };

describe("parser: OR, AND, NOT and brackets", () => {
  it("binds AND tighter than OR, and brackets group", () => {
    expect(shape(parseTaskQuery("status:doing label:bug OR priority:urgent").tree)).toEqual(["or", ["and", "status:doing", "label:bug"], "priority:urgent"]);
    expect(shape(parseTaskQuery("status:doing AND (label:bug OR priority:urgent)").tree)).toEqual(["and", "status:doing", ["or", "label:bug", "priority:urgent"]]);
    expect(shape(parseTaskQuery("(label:bug OR label:ux) -assignee:me").tree)).toEqual(["and", ["or", "label:bug", "label:ux"], "-assignee:me"]);
    expect(shape(parseTaskQuery("NOT (label:bug OR label:ux)").tree)).toEqual(["not", ["or", "label:bug", "label:ux"]]);
    expect(shape(parseTaskQuery("((status:done))").tree)).toEqual("status:done");
  });
  it("leaves R26 queries exactly as they were (no tree)", () => {
    const q = parseTaskQuery("assignee:me status:doing -label:wontfix \"free text\"");
    expect(q.tree).toBeUndefined();
    expect(q.terms).toHaveLength(4);
    expect(parseTaskQuery("re: invoice or quote").plain).toBe(true);
    expect(parseTaskQuery("(draft) notes").plain).toBe(true);
    expect(parseTaskQuery("the status was fine").plain).toBe(true);
    expect(parseTaskQuery("label:bug or").terms.map((t) => t.kind)).toEqual(["field", "text"]); // lower case is a word
    expect(looksLikeQuery("status WAS doing")).toBe(true);
  });
  it("gives errors with the character", () => {
    expect(err("(status:doing OR label:bug")).toBe("Expected ) (at character 27)");
    expect(err("label:bug )")).toBe("Unexpected ) (at character 11)");
    expect(err("label:bug OR")).toBe("OR needs a term after it (at character 13)");
    expect(err("OR label:bug")).toBe("Expected a term before OR (at character 1)");
    expect(err("label:bug AND OR x")).toBe("AND needs a term after it (at character 14)");
    expect(err("() label:bug")).toBe("Empty brackets (at character 2)");
    expect(err("label:bug NOT")).toBe("NOT needs a term after it (at character 14)");
    expect(err("NOT")).toBeNull(); // no key: plain words, as before
  });
});

describe("parser: history operators", () => {
  it("reads WAS and CHANGED with FROM, TO, AFTER, BEFORE, BY", () => {
    const [h] = parseTaskQuery("status CHANGED FROM todo TO doing,done AFTER -7d BEFORE 2026-10-30 BY me").terms;
    expect(h).toMatchObject({ kind: "history", key: "status", op: "changed", from: ["todo"], to: ["doing", "done"], after: "-7d", before: "2026-10-30", by: "me" });
    expect(parseTaskQuery("assignee WAS me").terms[0]).toMatchObject({ kind: "history", key: "assignee", op: "was", values: ["me"] });
    expect(parseTaskQuery('status WAS "in review" OR priority CHANGED').tree).toBeTruthy();
    expect(parseTaskQuery("-status WAS done").terms[0]).toMatchObject({ negate: true });
  });
  it("refuses what it cannot answer, with the character", () => {
    expect(err("status WAS")).toBe("status WAS needs a value (at character 11)");
    expect(err("assignee CHANGED FROM me")).toMatch(/^FROM works with status only/);
    expect(err("status WAS doing AFTER -7d")).toMatch(/^WAS takes no AFTER/);
    expect(err("status CHANGED AFTER soon")).toMatch(/^created takes a date/);
    expect(err("priority CHANGED TO huge")).toMatch(/^priority takes urgent/);
    expect(err("status CHANGED TO doing TO done")).toMatch(/^TO is given twice/);
  });
  it("keeps the SQL variable budget", () => {
    const many = Array.from({ length: 12 }, (_, i) => `status CHANGED TO s${i} BY person${i}`).join(" OR ");
    expect(err(many)).toMatch(/too many values/);
    expect(QUERY_MAX_COST).toBeLessThanOrEqual(80);
  });
});

describe("autocomplete for the new words", () => {
  const labels = (q: string) => suggest(q, q.length, { status: ["In review"] }).items.map((i) => i.label);
  it("offers WAS and CHANGED after a history key, then CHANGED's words, then values", () => {
    expect(labels("status ")).toEqual(["WAS", "CHANGED"]);
    expect(labels("status CHANGED ")).toEqual(["FROM", "TO", "AFTER", "BEFORE", "BY"]);
    expect(labels("assignee CHANGED ")).toEqual(["TO", "AFTER", "BEFORE", "BY"]);
    expect(labels("status CHANGED FROM todo ")).toEqual(["TO", "AFTER", "BEFORE", "BY"]);
    expect(labels("status WAS ")).toContain("In review");
    expect(labels("status CHANGED BY ")).toEqual(["me"]);
    expect(labels("label:bug O")).toContain("OR");
    expect(suggest("(lab", 4).items[0].insert).toBe("(label:");
    expect(labels("sta")).toContain("status WAS");
  });
});

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let me: string;
let clock: number;
let ids: Record<string, string>;
let st: Record<string, string>;

beforeEach(async () => {
  ctx = await makeTestApp();
  clock = new Date("2026-10-20T09:00:00Z").getTime();
  ctx.deps.now = () => new Date(clock);
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  me = (await c.get("/api/account/me")).body.user.id;
  const mb = (await c.post("/api/projects", { name: "Multies build", key: "MB" })).body.project;
  st = Object.fromEntries((mb.statuses as { id: string; category: string }[]).map((s) => [s.category, s.id]));
  const mk = async (title: string, extra: Record<string, unknown> = {}) => (await c.post("/api/tasks", { title, projectId: mb.id, ...extra })).body.task.id as string;
  ids = { a: await mk("Alpha", { labels: ["bug"] }), b: await mk("Bravo", { priority: "low" }), c: await mk("Charlie", { labels: ["ux"] }), d: await mk("Delta") };
  // History: Alpha todo -> doing (Oct 20), Bravo todo -> doing -> done (Oct 22), Charlie assigned to me then cleared (Oct 22), Delta priority high (Oct 25).
  await c.patch(`/api/tasks/${ids.a}`, { statusId: st.doing });
  clock += 2 * 86_400_000;
  await c.patch(`/api/tasks/${ids.b}`, { statusId: st.doing });
  await c.patch(`/api/tasks/${ids.b}`, { statusId: st.done });
  await c.patch(`/api/tasks/${ids.c}`, { assignee: `member:${me}` });
  await c.patch(`/api/tasks/${ids.c}`, { assignee: null });
  clock += 3 * 86_400_000;
  await c.patch(`/api/tasks/${ids.d}`, { priority: "high" });
  clock = new Date("2026-10-26T09:00:00Z").getTime();
});

const find = async (q: string) => {
  const r = await c.get(`/api/tasks?q=${encodeURIComponent(q)}&limit=200`);
  if (r.status !== 200) throw new Error(`${q}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.tasks as { title: string }[]).map((t) => t.title).sort();
};

describe("server: OR, brackets and history", () => {
  it("answers boolean queries", async () => {
    expect(await find("label:bug OR label:ux")).toEqual(["Alpha", "Charlie"]);
    expect(await find("(label:bug OR label:ux) AND status:doing")).toEqual(["Alpha"]);
    expect(await find("NOT (label:bug OR label:ux) project:MB")).toEqual(["Bravo", "Delta"]);
    expect(await find("label:bug OR priority:high OR status:done")).toEqual(["Alpha", "Bravo", "Delta"]);
  });
  it("answers history queries", async () => {
    expect(await find("status WAS doing")).toEqual(["Alpha", "Bravo"]);
    expect(await find("status WAS doing status:done")).toEqual(["Bravo"]);
    expect(await find("status CHANGED")).toEqual(["Alpha", "Bravo"]);
    expect(await find("status CHANGED FROM doing TO done")).toEqual(["Bravo"]);
    expect(await find("status CHANGED FROM todo")).toEqual(["Alpha", "Bravo"]);
    expect(await find("status CHANGED AFTER 2026-10-21")).toEqual(["Bravo"]);
    expect(await find("status CHANGED BEFORE 2026-10-21")).toEqual(["Alpha"]);
    expect(await find("status CHANGED AFTER -5d")).toEqual(["Bravo"]);
    expect(await find("status CHANGED BY me")).toEqual(["Alpha", "Bravo"]);
    expect(await find("status CHANGED BY olive")).toEqual(["Alpha", "Bravo"]);
    expect(await find("assignee WAS me")).toEqual(["Charlie"]);
    expect(await find("assignee:none assignee WAS me")).toEqual(["Charlie"]);
    expect(await find("assignee CHANGED TO none")).toEqual(["Charlie"]);
    expect(await find("priority CHANGED TO high")).toEqual(["Delta"]);
    expect(await find("priority WAS low")).toEqual(["Bravo"]);
    expect(await find("-status WAS doing project:MB")).toEqual(["Charlie", "Delta"]);
    expect(await find("status WAS doing OR priority CHANGED")).toEqual(["Alpha", "Bravo", "Delta"]);
  });
  it("answers a bad query with a 400 and the position", async () => {
    const r = await c.get(`/api/tasks?q=${encodeURIComponent("(status:doing OR label:bug")}`);
    expect(r.status).toBe(400);
    expect(r.body.error.details.position).toBe(27);
  });
  it("stays under the D1 variable limit and uses the change index", async () => {
    const before = d1Violations.length;
    // The biggest query the parser lets through (each group is one more costly history pair) must run on D1.
    const group = (i: number) => `(status CHANGED FROM todo TO doing AFTER -${i + 1}d BY sam${i} OR assignee WAS olive${i})`;
    let n = 1;
    while (err(Array.from({ length: n + 1 }, (_, i) => group(i)).join(" OR ")) === null) n++;
    expect(n).toBeGreaterThanOrEqual(2);
    const q = Array.from({ length: n }, (_, i) => group(i)).join(" OR ");
    expect((await c.get(`/api/tasks?q=${encodeURIComponent(q)}&limit=200`)).status).toBe(200);
    expect(d1Violations.length).toBe(before);
    const raw = (ctx.db as unknown as { $client: { prepare: (q: string) => { all: (...a: unknown[]) => unknown[] } } }).$client;
    const plan = raw.prepare("explain query plan select 1 from changes h1 where h1.entity_type = 'task' and h1.entity_id = ? and h1.verb is not null and h1.op = 'update'").all("x") as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/changes_entity_idx/);
  });
});
