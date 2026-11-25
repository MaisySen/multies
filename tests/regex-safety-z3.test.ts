/**
 * Review Z3: two pattern checks let catastrophic patterns through. The doc inbox's patternProblem took
 * `\w*\w*\w*\w*!` (38 s on 200 characters) and its matcher only looked at the clock between 2,000 character chunks;
 * the forms' safePattern took `(a|a)*`, which runs on the server for every public submission. Both now use one stricter
 * check (src/shared/safe-regex.ts), and each test call sees a bounded input (1,000 characters for a doc rule, 200 for a
 * form answer).
 */
import { describe, it, expect } from "vitest";
import { regexProblem } from "@/shared/safe-regex";
import { patternProblem, ruleMatches } from "@/server/services/suite/doc-inbox-match";
import { safePattern, fieldError } from "@/shared/form-logic";

const HOSTILE = [
  "\\w*\\w*\\w*\\w*!", "(a|a)*", "(a|aa)+$", "(a+)+$", "(a*)*b", "(\\d+)*x", "(.*a){12}", "\\d*\\d+\\d*z", "a*a*a*a*a*b", ".*.*.*=x",
  "(\\w+\\s?)*$", "(x+x+)+y", "[a-z]*[a-c]*[b-z]*!", "(?:a|b|ab)*c", "\\s*\\s*$x", "(a)\\1", "(?<n>a)\\k<n>", "a(?=b)", "(?<!x)y", "(?!a)b",
];
const FINE = ["invoice", "INV-\\d{4,8}", "^\\d{3}-\\d{4}$", "[A-Z]{2}\\d{6}", "acme (pty )?ltd", "total:?\\s+\\$?\\d+\\.\\d{2}", "colou?r", "\\bABN\\b\\s*\\d{11}", "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}"];

function timed(fn: () => unknown) { const t = performance.now(); fn(); return performance.now() - t; }

describe("Z3: one stricter regex check", () => {
  it("refuses overlapping repeats, choices under a repeat, nested repeats, back references and lookarounds", () => {
    for (const p of HOSTILE) expect(regexProblem(p), p).not.toBeNull();
    for (const p of FINE) expect(regexProblem(p), p).toBeNull();
  });

  it("the doc inbox and the forms both refuse the hostile patterns", () => {
    for (const p of HOSTILE) {
      expect(patternProblem("regex", p), p).not.toBeNull();
      expect(safePattern(p), p).toBe(false);
    }
    for (const p of FINE) expect(patternProblem("regex", p), p).toBeNull();
  });

  it("no hostile pattern takes long on hostile text, through either entry point", () => {
    const texts = ["a".repeat(5_000), "x".repeat(5_000) + "!", " ".repeat(5_000), "aab".repeat(2_000)];
    for (const pattern of HOSTILE) {
      for (const text of texts) {
        expect(timed(() => ruleMatches({ match: "regex", pattern, caseSensitive: false }, { text })), `${pattern} doc`).toBeLessThan(200);
        const field = { id: "f", label: "Code", type: "text", required: false, rules: { pattern } } as never;
        expect(timed(() => fieldError(field, text.slice(0, 300))), `${pattern} form`).toBeLessThan(200);
      }
    }
  });

  it("a form answer over 200 characters is not run through its pattern", () => {
    const field = { id: "f", label: "Code", type: "text", required: false, rules: { pattern: "[a-z]+" } } as never;
    expect(fieldError(field, "abc")).toBeNull();
    expect(fieldError(field, "a".repeat(201))).not.toBeNull();
  });
});
