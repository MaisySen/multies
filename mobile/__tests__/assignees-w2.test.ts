import { assigneeLabel, isAgentLike, pickable } from "@/lib/assignees";
import { quickAddToTask, parseQuickAdd } from "@/lib/quick-add";
import type { Assignee } from "@/api/types";

/** Round 2 (PR 23): the phone marks every kind of AI assignee, as the web does, and its pickers leave paused AIs out. */
const people: Assignee[] = [
  { id: "member:u1", type: "member", name: "Ana Lee", email: "ana@acme.io" },
  { id: "member:u2", type: "member", name: "Scout", email: null, isAgent: true },
  { id: "agent:a1", type: "agent", name: "Mailbot", email: null, isAgent: true },
  { id: "member:u3", type: "member", name: "Sleepy", email: null, isAgent: true, paused: true },
];

describe("phone AI badge and paused filtering", () => {
  it("marks an AI agent member, an agent and a member at an agent inbox, and no person", () => {
    expect(people.map(isAgentLike)).toEqual([false, true, true, true]);
    expect(assigneeLabel(people[1])).toBe("Scout (agent)");
    expect(assigneeLabel(people[0])).toBe("Ana Lee");
    // An older server's agent entry without isAgent still counts.
    expect(isAgentLike({ type: "agent" })).toBe(true);
  });

  it("pickers leave a paused AI out, unless the task already has it", () => {
    expect(pickable(people).map((p) => p.id)).toEqual(["member:u1", "member:u2", "agent:a1"]);
    expect(pickable(people, "member:u3").map((p) => p.id)).toContain("member:u3");
    // Quick add can't pick a paused AI with @.
    const r = quickAddToTask(parseQuickAdd("Check logs @sleepy"), [], pickable(people));
    expect(r.assigneeId).toBeUndefined();
    expect(r.unmatched).toEqual(["@sleepy"]);
  });
});
