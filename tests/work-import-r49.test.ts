import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { defaultMapping, mapRows, parseChecklist, parseLooseDate, readTable } from "@/server/services/work-import/parse";
import { runImport } from "@/server/services/work-import/service";
import { taskChecklistItems, taskComments, tasks } from "@/server/db/schema";
// @ts-expect-error plain JS fixture generator
import { makeCsv } from "./fixtures/work-import/generate-1000.mjs";

/** R49 (MB-236): realistic exports from each tool, and the gaps the R49 pass closed. */
const file = (name: string) => readFileSync(join(__dirname, "fixtures/work-import", name), "utf8");
const rowsOf = (name: string) => { const t = readTable(file(name), name); return { t, ...mapRows(t, defaultMapping(t)) }; };

async function owner() {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Owner Person");
  const me = (await c.get("/api/account/me")).body;
  const actor = { orgId: me.organization.id as string, userId: me.user.id as string, email: "owner@acme.io", name: "Owner Person", role: "owner" as const };
  return { ...ctx, c, actor };
}

describe("R49 import gaps", () => {
  it("Jira: a subtask whose Parent holds the Issue key nests under the issue like one that holds the Issue id", () => {
    const { t, rows } = rowsOf("jira.csv");
    expect(t.source).toBe("jira");
    expect(rows.map((r) => [r.title, r.parent])).toEqual([["Checkout page", null], ["Card form", "20001"], ["Receipt mail", "20001"]]);
    expect(rows[0].labels).toEqual(["frontend", "payments", "q4"]);
    expect(rows[0].comments).toEqual(["Looks good", "Ship it, please"]);
    expect(rows[0].description).toContain("Two steps at most.");
  });

  it("ClickUp: the Checklists cell becomes checklist items and the JSON comment list becomes comments", () => {
    const { rows } = rowsOf("clickup.csv");
    expect(rows[0].checklist).toEqual([{ title: "DNS ready", done: true }, { title: "Smoke test", done: false }]);
    expect(rows[1].comments).toEqual(["Ana: Draft by Friday"]);
    expect(rows[1].parent).toBe("86b001");
  });

  it("monday: subitems nest under their item, repeated header rows are skipped and the group becomes a label", () => {
    const { t, rows, skipped } = rowsOf("monday.csv");
    expect(t).toMatchObject({ source: "monday", name: "Website relaunch" });
    expect(skipped).toBe(0);
    expect(rows.map((r) => [r.title, r.parent, r.labels])).toEqual([
      ["Design home page", null, ["Sprint 1"]], ["Hero", "5001", ["Sprint 1"]], ["Footer", "5001", ["Sprint 1"]],
      ["Write copy", null, ["Sprint 1"]], ["Launch", null, ["Sprint 2"]],
    ]);
    expect(rows[1]).toMatchObject({ status: "Done", category: "done", assignees: ["Ana Admin"] });
    expect(rows.some((r) => r.title === "Name" || r.title === "Subitems")).toBe(false);
  });

  it("Asana and semicolon files: 2026/10/20, 30-10-2026 and 31.10.2026 dates, quoted newlines and a BOM", () => {
    expect(rowsOf("asana.csv").rows[2].due?.toISOString().slice(0, 10)).toBe("2026-10-20");
    const { rows } = rowsOf("semicolon.csv");
    expect(rows.map((r) => [r.title, r.due?.toISOString().slice(0, 10)])).toEqual([["Order stock; urgent", "2026-10-30"], ["Two line title", "2026-10-31"]]);
    expect(parseLooseDate("2026.10.05")?.toISOString().slice(0, 10)).toBe("2026-10-05");
    expect(parseLooseDate("05/10/2026")?.toISOString().slice(0, 10)).toBe("2026-05-10"); // month first, as before
  });

  it("reads checklist cells written as lines", () => {
    expect(parseChecklist("[x] One\n- [ ] Two\nThree")).toEqual([{ title: "One", done: true }, { title: "Two", done: false }, { title: "Three", done: false }]);
    expect(parseChecklist('[{"name":"A","checked":true},"B"]')).toEqual([{ title: "A", done: true }, { title: "B", done: false }]);
    expect(parseChecklist("")).toEqual([]);
  });

  it("lands ClickUp checklist items on the task, and monday subitems as subtasks", async () => {
    const { deps, db, actor } = await owner();
    const r = await runImport(deps, actor, { fileName: "clickup.csv", content: file("clickup.csv") });
    expect(r).toMatchObject({ created: 3, checklistItems: 2, comments: 1 });
    const launch = (await db.select().from(tasks).where(eq(tasks.title, "Launch site")).get())!;
    const items = await db.select().from(taskChecklistItems).where(eq(taskChecklistItems.taskId, launch.id));
    expect(items.map((x) => [x.title, x.done]).sort()).toEqual([["DNS ready", true], ["Smoke test", false]]);
    expect((await db.select().from(tasks).where(eq(tasks.parentId, launch.id))).length).toBe(2);
    expect((await db.select().from(taskComments)).length).toBe(1);
    const again = await runImport(deps, actor, { fileName: "clickup.csv", content: file("clickup.csv") });
    expect(again).toMatchObject({ created: 0, checklistItems: 0 });
    expect((await db.select().from(taskChecklistItems)).length).toBe(2);
    const m = await runImport(deps, actor, { fileName: "monday.csv", content: file("monday.csv") });
    expect(m).toMatchObject({ created: 5 });
    const design = (await db.select().from(tasks).where(eq(tasks.title, "Design home page")).get())!;
    expect((await db.select({ t: tasks.title }).from(tasks).where(eq(tasks.parentId, design.id))).map((x) => x.t).sort()).toEqual(["Footer", "Hero"]);
  });
});

describe("R49 1,000 row import", () => {
  it("brings a 1,000 row file in with 0 errors, nested subtasks, and within its time", async () => {
    const o = await owner();
    const content = makeCsv(1000) as string;
    const started = Date.now();
    let body = await runImport(o.deps, o.actor, { content, projectName: "Big" });
    let runs = 1;
    while (body.stopped && runs < 5) { body = await runImport(o.deps, o.actor, { content, projectName: "Big" }); runs++; }
    const ms = Date.now() - started;
    expect(body.stopped).toBeNull();
    const all = await o.db.select({ id: tasks.id, parentId: tasks.parentId }).from(tasks).where(eq(tasks.projectId, body.projectId!));
    expect(all.length).toBe(1000);
    expect(all.filter((x) => x.parentId).length).toBe(800);
    expect(ms).toBeLessThan(60_000);
    console.log(`R49 1000 rows: ${ms} ms in ${runs} run(s)`);
  }, 120_000);
});
