/**
 * R39 page history: a line diff between two plain texts (one line per block, as docs store them). Used by the server
 * (lines added and removed for the API and MCP) and by the history panel (the compare view). Bounded: past MAX_CELLS
 * the answer falls back to "every old line removed, every new line added", which is still correct, only coarser.
 */
export type DiffOp = { type: "same" | "add" | "del"; text: string };
const MAX_CELLS = 2_000_000;

export function diffLines(before: string, after: string): DiffOp[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  // Trim the common start and end first: most edits touch a few lines in the middle.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const head: DiffOp[] = a.slice(0, s).map((text) => ({ type: "same", text }));
  const tail: DiffOp[] = a.slice(ea).map((text) => ({ type: "same", text }));
  const ma = a.slice(s, ea), mb = b.slice(s, eb);
  const n = ma.length, m = mb.length;
  let mid: DiffOp[];
  if (!n || !m || n * m > MAX_CELLS) {
    mid = [...ma.map((text) => ({ type: "del" as const, text })), ...mb.map((text) => ({ type: "add" as const, text }))];
  } else {
    // Longest common subsequence table, filled from the end so the walk below goes forward.
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    mid = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { mid.push({ type: "same", text: ma[i] }); i++; j++; }
      else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) mid.push({ type: "del", text: ma[i++] });
      else mid.push({ type: "add", text: mb[j++] });
    }
    while (i < n) mid.push({ type: "del", text: ma[i++] });
    while (j < m) mid.push({ type: "add", text: mb[j++] });
  }
  return [...head, ...mid, ...tail];
}

/** How many lines a change added and removed. */
export function diffCounts(ops: DiffOp[]) {
  let added = 0, removed = 0;
  for (const o of ops) { if (o.type === "add") added++; else if (o.type === "del") removed++; }
  return { added, removed };
}

/** Words in a plain text, for the history list ("412 words"). */
export const wordCount = (text: string) => (text.match(/\S+/g) ?? []).length;
