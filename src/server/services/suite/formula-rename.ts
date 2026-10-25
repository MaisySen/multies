/**
 * R24 polish: when a custom field is renamed, formulas on the same project that read it by its
 * old name are rewritten to the new name, so they keep working. Pure text work here (no database);
 * fields.ts does the one write per affected formula field.
 */
import { tokenize } from "./formula";

const WORDS = new Set(["and", "or", "not", "true", "false", "null", "empty"]);

/** Braces a name for a formula. A name with a closing brace can't be braced, so it comes back null. */
const braced = (name: string) => (name.includes("}") ? null : `{${name}}`);

/**
 * Rewrites every reference to `oldName` (braced in any case, or a bare word) as `{newName}`.
 * Text inside quotes is left alone. Returns the expression unchanged if it can't be read.
 */
export function renameReferences(expression: string, oldName: string, newName: string): string {
  const old = oldName.trim().toLowerCase();
  const to = braced(newName.trim());
  if (!old || !to) return expression;
  let toks;
  try { toks = tokenize(expression); } catch { return expression; }
  const spans: [number, number][] = [];
  toks.forEach((t, i) => {
    if (t.k === "ref" && t.v.toLowerCase() === old) spans.push([t.at, expression.indexOf("}", t.at) + 1]);
    else if (t.k === "id" && t.v.toLowerCase() === old && !WORDS.has(old)) {
      const next = toks[i + 1];
      if (next && next.k === "op" && next.v === "(") return; // a function call, not a field
      spans.push([t.at, t.at + t.v.length]);
    }
  });
  let out = expression;
  for (const [a, b] of spans.reverse()) out = out.slice(0, a) + to + out.slice(b);
  return out;
}
