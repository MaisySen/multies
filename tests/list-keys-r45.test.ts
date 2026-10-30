import { describe, expect, it } from "vitest";
import { listKey, selectionMessage, type ListKeyState } from "@/web/lib/list-keys";

const start = (focus = 0, picked: number[] = []): ListKeyState => ({ focus, anchor: null, base: new Set(picked), picked: new Set(picked) });
const press = (s: ListKeyState, keys: string[], shift = false, count = 5000) => keys.reduce((st, k) => listKey(st, k, { shift }, count).state, s);
const sorted = (s: ListKeyState) => [...s.picked].sort((a, b) => a - b);

describe("R45 listKey", () => {
  it("arrows move the focus and stop at the ends", () => {
    expect(press(start(0), ["ArrowUp"]).focus).toBe(0);
    expect(press(start(0), ["ArrowDown", "ArrowDown"]).focus).toBe(2);
    expect(press(start(4998), ["ArrowDown", "ArrowDown", "ArrowDown"]).focus).toBe(4999);
    expect(press(start(10), ["End"]).focus).toBe(4999);
    expect(press(start(10), ["Home"]).focus).toBe(0);
  });
  it("Shift with arrows extends the run from the anchor and shrinks it again", () => {
    let s = press(start(3), ["ArrowDown", "ArrowDown", "ArrowDown"], true);
    expect(sorted(s)).toEqual([3, 4, 5, 6]);
    s = press(s, ["ArrowUp", "ArrowUp"], true);
    expect(sorted(s)).toEqual([3, 4]);
    s = press(s, ["ArrowUp", "ArrowUp"], true);
    expect(sorted(s)).toEqual([2, 3]);
  });
  it("rows picked before a run stay picked", () => {
    let s = press(start(0), [" "]);
    s = press(s, ["ArrowDown", "ArrowDown", "ArrowDown"]);
    s = press(s, ["ArrowDown"], true);
    expect(sorted(s)).toEqual([0, 3, 4]);
  });
  it("Space toggles the focused row and Escape clears", () => {
    let s = press(start(7), [" "]);
    expect(sorted(s)).toEqual([7]);
    s = press(s, [" "]);
    expect(sorted(s)).toEqual([]);
    s = press(start(1, [1, 2, 3]), ["Escape"]);
    expect(s.picked.size).toBe(0);
    expect(listKey(start(0), "Escape", {}, 10).handled).toBe(false);
  });
  it("Mod+A picks every row and M asks for the move menu", () => {
    expect(listKey(start(0), "a", { mod: true }, 4).state.picked.size).toBe(4);
    expect(listKey(start(0), "m", {}, 4).openMove).toBe(true);
    expect(listKey(start(0), "x", {}, 4).handled).toBe(false);
    expect(listKey(start(0), "ArrowDown", {}, 0).handled).toBe(false);
  });
  it("says how many are selected", () => {
    expect(selectionMessage(3, 5000, "6 pt")).toBe("Selected 3 of 5000, 6 pt");
    expect(selectionMessage(0, 10)).toBe("Selection cleared");
  });
});
