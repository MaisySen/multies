/**
 * Wave 2 review X9: the audit log's address check (memberSafeAudit) backtracked exponentially on a domain with many
 * labels ("x@" + "a.".repeat(26) + "1" took about 0.7 s, doubling per label) and quadratically on a long run of text
 * with no address. It now runs from each @ with a sticky, dot free label pattern: linear, same answers.
 */
import { describe, it, expect } from "vitest";
import { memberSafeAudit } from "@/server/services/audit";

const kept = (note: string) => (memberSafeAudit({ metadata: { note } }).metadata as Record<string, unknown>).note === note;

describe("X9: the audit address check is linear", () => {
  it("hostile inputs finish fast", () => {
    for (const hostile of [
      "x@" + "a.".repeat(5000) + "1",
      "a".repeat(200_000),
      "a.".repeat(100_000),
      "a@".repeat(50_000),
      '"'.repeat(50_000) + "@",
      ("x@" + "a.".repeat(40) + "1 ").repeat(2000),
    ]) {
      const t = performance.now();
      kept(hostile);
      expect(performance.now() - t, hostile.slice(0, 30)).toBeLessThan(250);
    }
  });

  it("still finds the same addresses and leaves versions alone", () => {
    for (const a of ["x@primer.рф", "x@a.b.भारत", '"q r"@ex.com', "ann@acme.io", "mail ann.lee+x@mail.acme.co.uk now", "x＠acme.io", "x%40acme.io", "x@a.b.cd.1"]) expect(kept(a), a).toBe(false);
    for (const a of ["pkg@1.2.3", "no address here", "@acme.io", "a@b", "x@acme.", "a <@acme.io>"]) expect(kept(a), a).toBe(true);
  });
});
