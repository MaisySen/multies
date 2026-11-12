import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { projectStatuses, tasks } from "@/server/db/schema";
import { foldedColumnsKey, foldedLabel, liveFolded, parseFolded, toggleFolded } from "../src/shared/board-columns-k1";
import { statusKey, suggestColumn, suggestStatusMap } from "../src/shared/status-import-k1";

/** K1 (owner's top board item, 7 Nov): folding board columns, and imported statuses landing in the right column. */
describe("K1 folded columns", () => {
  it("keys per project and grouping", () => {
    expect(foldedColumnsKey("prj_1", "status")).toBe("multies.board.cols.prj_1.status");
    expect(foldedColumnsKey("prj_1", "field:fld_2")).not.toBe(foldedColumnsKey("prj_1", "status"));
  });
  it("reads what was stored, and anything broken as none folded", () => {
    expect([...parseFolded('["a","b"]')]).toEqual(["a", "b"]);
    expect([...parseFolded('["a",3,null]')]).toEqual(["a"]);
    for (const bad of [null, undefined, "", "{", '{"a":1}', "42"]) expect(parseFolded(bad).size).toBe(0);
  });
  it("toggles without touching the old set", () => {
    const a = new Set(["x"]);
    const b = toggleFolded(a, "y");
    expect([...b].sort()).toEqual(["x", "y"]);
    expect([...a]).toEqual(["x"]);
    expect([...toggleFolded(b, "x")]).toEqual(["y"]);
  });
  it("drops columns that are gone", () => {
    expect([...liveFolded(new Set(["a", "gone"]), ["a", "b"])]).toEqual(["a"]);
  });
  it("labels a folded column for screen readers", () => {
    expect(foldedLabel("Done", 1)).toBe("Expand Done, 1 card");
    expect(foldedLabel("Doing", 4, 3)).toBe("Expand Doing, 4 cards, limit 3");
  });
});

describe("K1 status import mapping", () => {
  const cols = [
    { id: "s_todo", name: "To do", category: "todo" as const, position: 0 },
    { id: "s_doing", name: "Doing", category: "doing" as const, position: 1 },
    { id: "s_review", name: "Review", category: "doing" as const, position: 2 },
    { id: "s_done", name: "Done", category: "done" as const, position: 3 },
  ];
  it("treats case, spaces and dashes as the same name", () => {
    expect(statusKey("In-Progress")).toBe(statusKey("in progress"));
    expect(suggestColumn("to-do", cols)?.id).toBe("s_todo");
  });
  it("maps names that mean the same column", () => {
    expect(suggestColumn("Complete", cols)?.id).toBe("s_done");
    expect(suggestColumn("Closed", cols)?.id).toBe("s_done");
    expect(suggestColumn("In Progress", cols)?.id).toBe("s_doing");
    expect(suggestColumn("Code review", cols)?.id).toBe("s_review");
    expect(suggestColumn("Open", cols)?.id).toBe("s_todo");
  });
  it("leaves unknown names, and names with no matching column, to be added as new", () => {
    expect(suggestColumn("QA on staging", cols)).toBeNull();
    expect(suggestColumn("Backlog", cols)).toBeNull();
    expect(suggestColumn("Blocked", cols)).toBeNull();
  });
  it("never maps across groups", () => {
    expect(suggestColumn("Done", cols, "todo")).toBeNull();
    expect(suggestColumn("Complete", cols, "done")?.id).toBe("s_done");
  });
  it("builds a whole map and keeps the person's choices", () => {
    const file = [{ name: "Complete", category: "done" as const }, { name: "WIP", category: "doing" as const }, { name: "Ideas", category: "todo" as const }];
    expect(suggestStatusMap(file, cols)).toEqual({ complete: "s_done", wip: "s_doing" });
    expect(suggestStatusMap(file, cols, { complete: null })).toEqual({ wip: "s_doing" });
  });
});

describe("K1 status import mapping, end to end", () => {
  async function board() {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Owner Person");
    const made = (await c.post("/api/projects", { name: "Board" })).body;
    const p = (made.project ?? made) as { id: string };
    const before = await ctx.db.select().from(projectStatuses).where(eq(projectStatuses.projectId, p.id));
    return { ...ctx, c, p, before };
  }
  const file = "Title,Status\nA,Complete\nB,Closed\nC,QA on staging\n";

  it("lands 'Complete' and 'Closed' in the board's done column, adds only the unknown status", async () => {
    const { c, db, p, before } = await board();
    const done = before.find((s) => s.category === "done")!;
    const run = await c.post("/api/data-moves/imports/run", { kind: "tasks", content: file, projectId: p.id });
    expect(run.status).toBe(200);
    const after = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, p.id));
    expect(after.length).toBe(before.length + 1);
    expect(after.map((s) => s.name)).toContain("QA on staging");
    expect(after.map((s) => s.name)).not.toContain("Complete");
    const rows = await db.select().from(tasks).where(eq(tasks.projectId, p.id));
    expect(rows.find((t) => t.title === "A")!.statusId).toBe(done.id);
    expect(rows.find((t) => t.title === "B")!.statusId).toBe(done.id);
  });

  it("keeps a status as a new column when the person picks Add as new (sent as null)", async () => {
    const { c, db, p, before } = await board();
    const run = await c.post("/api/data-moves/imports/run", { kind: "tasks", content: file, projectId: p.id, statusMap: { complete: null } });
    expect(run.status).toBe(200);
    const after = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, p.id));
    expect(after.map((s) => s.name)).toContain("Complete");
    expect(after.map((s) => s.name)).not.toContain("Closed");
    expect(after.length).toBe(before.length + 2);
  });
});
