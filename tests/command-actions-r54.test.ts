import { describe, expect, it } from "vitest";
import { typedActionChange } from "@/web/lib/commands/typed-action";
import type { Task } from "@/web/pages/app/work/data";
import { dueWords, fold, matchPerson, matchStatus, parseCommand, parseDueWords, resolveCommand, type CmdPerson, type CmdStatus, type ParsedCommand } from "@/shared/command-actions";

/** R54 (plan idea 8): typed words in the command menu. Wednesday 28 Oct 2026, 10:00 UTC. */
const NOW = new Date("2026-10-28T10:00:00Z");
const TZ = "UTC";
const people: CmdPerson[] = [
  { id: "u1", type: "member", name: "Asha Rao", email: "asha@example.com" },
  { id: "u2", type: "member", name: "Sam Lee", email: "sam.lee@example.com" },
  { id: "u3", type: "member", name: "Sam Ortiz", email: "sortiz@example.com" },
  { id: "u4", type: "member", name: "José Núñez", email: "jn@example.com" },
  { id: "a1", type: "agent", name: "Invoice Bot", email: null },
];
const me = people[3];
const ctx = { people, me, now: NOW, timeZone: TZ };
const p = (s: string, extra: Record<string, unknown> = {}) => parseCommand(s, { ...ctx, ...extra });
const statuses: CmdStatus[] = [
  { id: "s1", name: "Backlog", category: "todo", position: 0 },
  { id: "s2", name: "In progress", category: "doing", position: 1 },
  { id: "s3", name: "Waiting on client", category: "doing", position: 2 },
  { id: "s4", name: "Done", category: "done", position: 3 },
];
const task = { ref: "MB-12", labels: ["design"], statusId: "s1", assigneeId: null };
const run = (s: string) => resolveCommand(p(s) as ParsedCommand, task, statuses, NOW);

describe("parseCommand", () => {
  it("assign <ref> to <first name>", () => {
    expect(p("assign MB-12 to Asha")).toEqual({ ref: "MB-12", clauses: [{ kind: "assign", person: people[0] }] });
  });
  it("assign without to, ref first, lower case ref", () => {
    expect(p("mb-12 assign asha")?.clauses).toEqual([{ kind: "assign", person: people[0] }]);
    expect(p("mb-12 assign asha")?.ref).toBe("MB-12");
  });
  it("full name, email and email prefix", () => {
    expect(p("assign MB-12 to Sam Lee")?.clauses[0]).toEqual({ kind: "assign", person: people[1] });
    expect(p("assign MB-12 to sortiz@example.com")?.clauses[0]).toEqual({ kind: "assign", person: people[2] });
    expect(p("assign MB-12 to sam.lee")?.clauses[0]).toEqual({ kind: "assign", person: people[1] });
  });
  it("accents and case do not matter", () => {
    expect(p("assign MB-12 to jose")?.clauses[0]).toEqual({ kind: "assign", person: people[3] });
    expect(p("ASSIGN MB-12 TO JOSÉ NÚÑEZ")?.clauses[0]).toEqual({ kind: "assign", person: people[3] });
  });
  it("a shared first name gives the choices", () => {
    const c = p("assign MB-12 to Sam")?.clauses[0];
    expect(c?.kind).toBe("assign-ambiguous");
    expect(c && "choices" in c ? c.choices.map((x) => x.id) : []).toEqual(["u2", "u3"]);
  });
  it("me is the signed in person", () => {
    expect(p("assign MB-12 to me")?.clauses[0]).toEqual({ kind: "assign", person: me });
  });
  it("an unknown name is a problem, not a search", () => {
    expect(p("assign MB-12 to Zed")?.clauses[0]).toEqual({ kind: "assign-unknown", query: "Zed" });
  });
  it("@mention style", () => {
    expect(p("MB-12 @Asha Rao due tomorrow")?.clauses).toEqual([{ kind: "assign", person: people[0] }, { kind: "due", due: "2026-10-29" }]);
  });
  it("unassign and assign to nobody", () => {
    expect(p("unassign MB-12")?.clauses).toEqual([{ kind: "unassign" }]);
    expect(p("assign MB-12 to nobody")?.clauses).toEqual([{ kind: "unassign" }]);
  });
  it("due date words reuse the meeting parser", () => {
    expect(p("MB-12 due tomorrow")?.clauses).toEqual([{ kind: "due", due: "2026-10-29" }]);
    expect(p("MB-12 due Friday")?.clauses).toEqual([{ kind: "due", due: "2026-10-30" }]);
    expect(p("MB-12 due next Wed")?.clauses).toEqual([{ kind: "due", due: "2026-11-04" }]);
    expect(p("MB-12 due 3 Nov")?.clauses).toEqual([{ kind: "due", due: "2026-11-03" }]);
    expect(p("MB-12 by 2026-12-01")?.clauses).toEqual([{ kind: "due", due: "2026-12-01" }]);
    expect(p("MB-12 due in 3 days")?.clauses).toEqual([{ kind: "due", due: "2026-10-31" }]);
    expect(p("MB-12 due in 2 weeks")?.clauses).toEqual([{ kind: "due", due: "2026-11-11" }]);
  });
  it("due none clears; a non date is a problem", () => {
    expect(p("MB-12 due none")?.clauses).toEqual([{ kind: "due-clear" }]);
    expect(p("MB-12 due someday maybe")?.clauses).toEqual([{ kind: "due-unknown", query: "someday maybe" }]);
  });
  it("status, move to, mark as, done", () => {
    expect(p("MB-12 status waiting on client")?.clauses).toEqual([{ kind: "status", query: "waiting on client" }]);
    expect(p("move MB-12 to In progress")?.clauses).toEqual([{ kind: "status", query: "In progress" }]);
    expect(p("mark MB-12 as done")?.clauses).toEqual([{ kind: "done" }]);
    expect(p("MB-12 done")?.clauses).toEqual([{ kind: "done" }]);
  });
  it("priority words, both orders", () => {
    expect(p("MB-12 priority high")?.clauses).toEqual([{ kind: "priority", priority: "high" }]);
    expect(p("MB-12 urgent priority")?.clauses).toEqual([{ kind: "priority", priority: "urgent" }]);
    expect(p("MB-12 priority none")?.clauses).toEqual([{ kind: "priority", priority: "none" }]);
    expect(p("MB-12 priority hgh")?.clauses).toEqual([{ kind: "priority-unknown", query: "hgh" }]);
  });
  it("label", () => {
    expect(p("MB-12 label customer request")?.clauses).toEqual([{ kind: "label", label: "customer request" }]);
  });
  it("several clauses in one line, commas and and", () => {
    expect(p("assign MB-12 to Asha due Friday priority high")?.clauses).toEqual([
      { kind: "assign", person: people[0] }, { kind: "due", due: "2026-10-30" }, { kind: "priority", priority: "high" },
    ]);
    expect(p("MB-12 assign Asha, due tomorrow and label qa")?.clauses).toEqual([
      { kind: "assign", person: people[0] }, { kind: "due", due: "2026-10-29" }, { kind: "label", label: "qa" },
    ]);
  });
  it("extra spaces and any project key", () => {
    expect(p("   assign   OPS-7   to   asha   ")).toEqual({ ref: "OPS-7", clauses: [{ kind: "assign", person: people[0] }] });
    expect(p("assign BHM2-140 to asha")?.ref).toBe("BHM2-140");
  });
  it("plain words stay a search", () => {
    expect(p("quarterly report")).toBeNull();
    expect(p("MB-12")).toBeNull();
    expect(p("MB-12 quarterly report")).toBeNull();
    expect(p("assign")).toBeNull();
    expect(p("due tomorrow")).toBeNull(); // no task named and none focused
    expect(p("")).toBeNull();
  });
  it("a focused task stands in when the words start with a verb", () => {
    expect(p("assign to me", { defaultRef: "BHM-3" })).toEqual({ ref: "BHM-3", clauses: [{ kind: "assign", person: me }] });
    expect(p("done", { defaultRef: "BHM-3" })?.clauses).toEqual([{ kind: "done" }]);
    expect(p("design review", { defaultRef: "BHM-3" })).toBeNull();
    expect(p("by tomorrow", { defaultRef: "BHM-3" })).toBeNull();
  });
});

describe("resolveCommand", () => {
  it("one preview in plain words", () => {
    const r = run("assign MB-12 to Asha due Friday priority high");
    expect(r.preview).toBe("MB-12: assign to Asha Rao, due Fri 30 Oct, priority High");
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ assignee: people[0], due: "2026-10-30", priority: "high" });
  });
  it("status by name, start of name, and done", () => {
    expect(run("move MB-12 to waiting").status?.id).toBe("s3");
    expect(run("MB-12 status in progress").status?.id).toBe("s2");
    expect(run("MB-12 done")).toMatchObject({ preview: "MB-12: mark Done", status: { id: "s4" } });
    expect(run("MB-12 status shipped").problems).toEqual(['This project has no status called "shipped".']);
  });
  it("labels add to the ones the task has, once", () => {
    expect(run("MB-12 label qa").labels).toEqual(["design", "qa"]);
    expect(run("MB-12 label Design").labels).toEqual(["design"]);
  });
  it("problems name what is wrong", () => {
    expect(run("assign MB-12 to Sam").problems[0]).toBe('"Sam" matches Sam Lee, Sam Ortiz. Type more of the name.');
    expect(run("assign MB-12 to Zed").problems[0]).toBe('No one called "Zed" in this workspace.');
    expect(run("MB-12 due someday").problems[0]).toMatch(/not a date/);
  });
  it("unassign and clear the due date", () => {
    expect(run("unassign MB-12 due none")).toMatchObject({ preview: "MB-12: unassign, no due date", assignee: null, due: null });
  });
});

describe("helpers", () => {
  it("fold, dueWords, parseDueWords, matchPerson, matchStatus", () => {
    expect(fold(" Núñez ")).toBe("nunez");
    expect(dueWords("2026-10-30", NOW)).toBe("Fri 30 Oct");
    expect(dueWords("2027-01-04", NOW)).toBe("Mon 4 Jan 2027");
    expect(parseDueWords("Friday maybe", NOW, TZ)).toBeNull();
    expect(matchPerson("as", people).kind).toBe("assign");
    expect(matchPerson("me", people, null).kind).toBe("assign-unknown");
    expect(matchStatus(null, statuses)?.id).toBe("s4");
    expect(matchStatus("todo", statuses)?.id).toBe("s1");
  });
  it("copy has no dashes", () => {
    const texts = [run("assign MB-12 to Sam").problems[0], run("MB-12 due x").problems[0], run("MB-12 priority q").problems[0], run("MB-12 status q").problems[0]];
    for (const t of texts) expect(t).not.toMatch(/[\u2013\u2014]| - /);
  });
});


describe("typedActionChange (web)", () => {
  it("one patch for the server, the list view, and the undo pair", () => {
    const t = { id: "t1", ref: "MB-12", projectId: "p1", labels: ["design"], statusId: "s1", statusName: "Backlog", statusColor: "#888", status: "todo", assigneeId: "u2", assignee: { type: "member", id: "u2", name: "Sam Lee" }, priority: "low", due: "2026-10-01T00:00:00.000Z" } as unknown as Task;
    const r = run("assign MB-12 to Asha due Friday priority high label qa");
    const c = typedActionChange(t, r, { id: "p1", statuses: [] } as never);
    expect(c.patch).toEqual({ assignee: "u1", due: "2026-10-30", priority: "high", labels: ["design", "qa"] });
    expect(c.view).toMatchObject({ assigneeId: "u1", assignee: { id: "u1", name: "Asha Rao" }, due: "2026-10-30", priority: "high" });
    expect(c.undoPatch).toEqual({ assignee: "u2", due: "2026-10-01", priority: "low", labels: ["design"] });
    expect(c.undoView).toMatchObject({ assigneeId: "u2", assignee: { name: "Sam Lee" }, due: "2026-10-01T00:00:00.000Z" });
  });
});
