/**
 * R45: keyboard selection for a long list (the backlog), as pure functions so they are tested without a browser.
 * Arrow keys move the focused row; Shift with an arrow extends the selection from the anchor row (the run grows and
 * shrinks with the focus, rows picked before the run stay picked); Space toggles the focused row; Escape clears.
 */
export interface ListKeyState {
  focus: number;
  anchor: number | null;
  /** Indexes picked before the current Shift run started; the run is added on top. */
  base: ReadonlySet<number>;
  picked: ReadonlySet<number>;
}

export type ListKeyResult = { state: ListKeyState; handled: boolean; openMove?: boolean };

const range = (a: number, b: number) => {
  const out: number[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i);
  return out;
};

export function listKey(s: ListKeyState, key: string, mods: { shift?: boolean; mod?: boolean }, count: number): ListKeyResult {
  if (count <= 0) return { state: s, handled: false };
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  const move = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 }[key as "ArrowDown"];
  if (move !== undefined || key === "Home" || key === "End") {
    const next = key === "Home" ? 0 : key === "End" ? count - 1 : clamp(s.focus + move!);
    if (!mods.shift) return { state: { ...s, focus: next, anchor: null, base: s.picked }, handled: true };
    const anchor = s.anchor ?? s.focus;
    const base = s.anchor == null ? s.picked : s.base;
    const picked = new Set(base);
    for (const i of range(anchor, next)) picked.add(i);
    return { state: { focus: next, anchor, base, picked }, handled: true };
  }
  if (key === " " && !mods.mod) {
    const picked = new Set(s.picked);
    if (picked.has(s.focus)) picked.delete(s.focus); else picked.add(s.focus);
    return { state: { ...s, anchor: null, base: picked, picked }, handled: true };
  }
  if ((key === "a" || key === "A") && mods.mod) {
    const picked = new Set(range(0, count - 1));
    return { state: { ...s, anchor: null, base: picked, picked }, handled: true };
  }
  if (key === "Escape") {
    if (!s.picked.size) return { state: s, handled: false };
    return { state: { ...s, anchor: null, base: new Set(), picked: new Set() }, handled: true };
  }
  if ((key === "m" || key === "M") && !mods.mod) return { state: s, handled: true, openMove: true };
  return { state: s, handled: false };
}

/** What a screen reader hears after the selection changes. */
export function selectionMessage(n: number, total: number, unit?: string): string {
  if (!n) return "Selection cleared";
  return `${n} selected${unit ? `, ${unit}` : ""}, of ${total}`;
}
