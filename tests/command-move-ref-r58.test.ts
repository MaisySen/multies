import { describe, expect, it } from "vitest";
import { parseCommand, refChangeWords, resolveCommand, type CmdPerson, type CmdProject, type CmdStatus, type ParsedCommand } from "@/shared/command-actions";

/** R58 (MB-246): a move says the ref changes; a label no task uses yet is listed so the menu can ask first. */
const NOW = new Date("2026-10-28T10:00:00Z");
const people: CmdPerson[] = [{ id: "u1", type: "member", name: "Asha Rao", email: "asha@example.com" }];
const statuses: CmdStatus[] = [{ id: "s1", name: "To do", category: "todo", position: 0 }];
const projects: CmdProject[] = [
  { id: "p1", name: "Tasks", key: "TSK", statuses },
  { id: "p2", name: "Blue Harbor move", key: "BHM", statuses: [{ id: "b1", name: "To do", category: "todo", position: 0 }] },
];
const task = { ref: "TSK-3", labels: ["design"], statusId: "s1", assigneeId: null, projectId: "p1", category: "todo" };
const run = (s: string, ps: CmdProject[] = projects, known: string[] | null = ["design", "later"]) =>
  resolveCommand(parseCommand(s, { people, me: people[0], now: NOW, timeZone: "UTC" }) as ParsedCommand, task, statuses, NOW, { projects: ps, knownLabels: known ?? undefined });

describe("command menu: a move changes the ref (R58 MB-246)", () => {
  it("names the new ref when the next number is known", () => {
    const withNext = projects.map((p) => (p.id === "p2" ? { ...p, nextNumber: 16 } : p));
    const r = run("move TSK-3 to Blue Harbor move", withNext);
    expect(r.refChange).toEqual({ from: "TSK-3", to: "BHM-16", key: "BHM" });
    expect(r.preview).toBe("TSK-3: move to Blue Harbor move (status To do), TSK-3 becomes BHM-16");
  });
  it("says a new number is coming when it is not known", () => {
    const r = run("move TSK-3 to project blue");
    expect(r.refChange).toEqual({ from: "TSK-3", to: null, key: "BHM" });
    expect(r.preview).toContain("TSK-3 gets a new BHM number");
    expect(refChangeWords({ from: "A-1", to: null, key: "B" })).toBe("A-1 gets a new B number");
  });
  it("a status change in the same project keeps the ref", () => {
    expect(run("move TSK-3 to to do").refChange).toBeUndefined();
    expect(run("TSK-3 +later").refChange).toBeUndefined();
  });
});

describe("command menu: new labels are listed (R58 MB-246)", () => {
  it("lists only labels no task uses yet", () => {
    expect(run("TSK-3 +urgent").newLabels).toEqual(["urgent"]);
    expect(run("TSK-3 +later").newLabels).toBeUndefined();
    expect(run("TSK-3 +urgent +blocked").newLabels).toEqual(["urgent", "blocked"]);
    expect(run("TSK-3 +Design").newLabels).toBeUndefined(); // already on the task, any case
  });
  it("lists nothing when the labels in use are not known", () => {
    expect(run("TSK-3 +urgent", projects, null).newLabels).toBeUndefined();
  });
});
