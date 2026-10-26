import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R34 (MB-192): no browser confirm/prompt/alert boxes in the web app. They can't match dark mode, name the
// object or validate input; useDialogs() / PromptDialog / ConfirmButton in src/web/components/ui/confirm.tsx can.
// eslint (no-restricted-globals) catches most of these; this test also runs in the unit gate.
const ROOT = join(__dirname, "..", "src", "web");
const BAD = /(?:\bwindow\.|\bglobalThis\.|(?<![\w.$]))(confirm|prompt|alert)\s*\(/;

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

/** Lines that call a browser dialog, ignoring comments and our own awaited themed versions. */
export function browserDialogCalls(source: string) {
  const hits: string[] = [];
  source.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    if (!BAD.test(code)) return;
    if (/\bawait\s+(confirm|prompt)\s*\(/.test(code) && !/window\.|globalThis\./.test(code)) return; // useDialogs()
    if (/\b(function|const|let)\s+(confirm|prompt|alert)\b/.test(code)) return;
    hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

describe("no browser dialogs in src/web (R34)", () => {
  it("flags window.confirm, bare prompt() and alert() but not the themed await confirm()", () => {
    expect(browserDialogCalls(`if (window.confirm("x")) go();`)).toHaveLength(1);
    expect(browserDialogCalls(`const v = prompt("Name");`)).toHaveLength(1);
    expect(browserDialogCalls(`alert("hi")`)).toHaveLength(1);
    expect(browserDialogCalls(`if (!(await confirm({ title: "Delete?" }))) return;`)).toHaveLength(0);
    expect(browserDialogCalls(`// window.confirm("old")`)).toHaveLength(0);
    expect(browserDialogCalls(`toast.confirm("x"); api.prompt("y")`)).toHaveLength(0);
  });
  it("finds none in the web app", () => {
    const found = walk(ROOT).flatMap((f) => browserDialogCalls(readFileSync(f, "utf8")).map((h) => `${f.slice(ROOT.length + 1)}:${h}`));
    expect(found).toEqual([]);
  });
});
