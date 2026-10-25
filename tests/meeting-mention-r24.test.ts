import { describe, it, expect } from "vitest";
import { mentionMatches } from "@/web/lib/mention-match";
import { findAssignee } from "@/shared/action-items";

const people = [
  { type: "member" as const, id: "u1", name: "Maya Patel" },
  { type: "member" as const, id: "u2", name: "Sam Lee" },
  { type: "agent" as const, id: "a1", name: "Ops Bot" },
  { type: "member" as const, id: "u3", name: "Samira Khan" },
];

describe("meeting notes @ mention picker", () => {
  it("lists people by a word that starts with the query, then names that contain it, case blind, with a limit", () => {
    expect(mentionMatches(people, "").map((p) => p.id)).toEqual(["u1", "u2", "a1", "u3"]);
    expect(mentionMatches(people, "", 2)).toHaveLength(2);
    expect(mentionMatches(people, "sam").map((p) => p.id)).toEqual(["u2", "u3"]);
    expect(mentionMatches(people, "PAT").map((p) => p.id)).toEqual(["u1"]);
    expect(mentionMatches(people, "bot").map((p) => p.id)).toEqual(["a1"]);
    expect(mentionMatches(people, "ira").map((p) => p.id)).toEqual(["u3"]);
    expect(mentionMatches(people, "zzz")).toEqual([]);
  });

  it("inserts text the action item parser reads as the assignee, for full names with spaces and for agents", () => {
    for (const p of people) {
      const text = `Send the deck @${p.name} due Fri`;
      expect(findAssignee(text, people)?.person.id).toBe(p.id);
    }
  });
});
