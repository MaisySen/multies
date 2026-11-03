import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** POL2 (HQ MB-349): a loading wrapper that names itself needs a role, or axe reports aria-prohibited-attr (serious). */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith(".tsx") ? [p] : []; });
}
// SOC1 owns the social pages this round; its one wrapper is fixed when it lands (listed so this test stays honest).
const PENDING = new Set(["src/web/pages/app/social-p3.tsx"]);

describe("loading wrappers carry a role (HQ MB-349)", () => {
  it("no busy or Loading named div or span without a role", () => {
    const bad: string[] = [];
    for (const f of files("src/web")) {
      if (PENDING.has(f)) continue;
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/<(div|span|ul|section)\b[^<>]*?(aria-busy=\{?"?true"?\}?[^<>]*?aria-label|aria-label=\{?[`"]Loading|aria-label=[^<>]*?aria-busy=\{?"?true)[^<>]*?>/g)) {
        if (!/\brole=/.test(m[0])) bad.push(`${f}: ${m[0].slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it("the app loading skeleton is a status with a name", () => {
    const s = readFileSync("src/web/layouts/app-skeleton.tsx", "utf8");
    expect(s).toMatch(/<div role="status" className="flex min-h-dvh" aria-busy="true" aria-label="Loading">/);
  });
});
