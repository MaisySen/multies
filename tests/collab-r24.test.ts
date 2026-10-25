import { describe, expect, it } from "vitest";
import { collabMode, editingLabel, initialsOf, leaderOf, liveSaveStep } from "@/web/pages/app/work/collab-logic";

/** Round 24: the decisions behind live meeting notes and the doc page sharing one save loop. */
describe("collab mode and leader", () => {
  it("is live only when the room synced, else the single editor", () => {
    expect(collabMode(null)).toBe("solo");
    expect(collabMode(undefined)).toBe("solo");
    expect(collabMode({ ydoc: {}, provider: {} })).toBe("live");
  });
  it("the lowest connected client id leads, and a client alone leads", () => {
    expect(leaderOf(5, [])).toBe(true);
    expect(leaderOf(5, [5, 9])).toBe(true);
    expect(leaderOf(9, [5, 9])).toBe(false);
    // Presence not arrived yet: the local id still counts.
    expect(leaderOf(3, [5, 9])).toBe(true);
    expect(leaderOf(7, new Set([5, 9]).keys())).toBe(false);
  });
});

describe("live save step", () => {
  it("only the leader writes", () => {
    expect(liveSaveStep({ leader: false, hash: "a", savedHash: "b" })).toBe("skip");
    expect(liveSaveStep({ leader: false, hash: "a", savedHash: "b", titlePatch: true })).toBe("skip");
  });
  it("no write when the content hash has not moved (0 writes for remote echoes)", () => {
    expect(liveSaveStep({ leader: true, hash: "a", savedHash: "a" })).toBe("skip");
    expect(liveSaveStep({ leader: true, hash: "a", savedHash: "b" })).toBe("save");
    expect(liveSaveStep({ leader: true, hash: "a", savedHash: undefined })).toBe("save");
  });
  it("a title change saves even with the same content", () => {
    expect(liveSaveStep({ leader: true, hash: "a", savedHash: "a", titlePatch: true })).toBe("save");
  });
});

describe("presence copy", () => {
  it("names who else is editing by first name", () => {
    expect(editingLabel([])).toBe("Only you are here");
    expect(editingLabel(["Maya Lin"])).toBe("Maya is editing");
    expect(editingLabel(["Maya Lin", "Ben Ross"])).toBe("Maya and Ben are editing");
    expect(editingLabel(["Maya", "Ben", "Ana"])).toBe("Maya, Ben and Ana are editing");
    expect(editingLabel(["Maya", "Ben", "Ana", "Joe", "Kim"])).toBe("Maya, Ben and 3 others are editing");
    expect(editingLabel(["  "])).toBe("Someone is editing");
  });
  it("makes one or two initials", () => {
    expect(initialsOf("Maya Lin")).toBe("ML");
    expect(initialsOf("maya")).toBe("M");
    expect(initialsOf("ben.ross@example.com")).toBe("BC");
    expect(initialsOf("")).toBe("?");
  });
});
