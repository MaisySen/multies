import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(n) ? [p] : [];
  });
}

describe("R42 phone pickers and list add", () => {
  it("no page draws a raw select; every choice goes through the shared Select so phones get the bottom sheet", () => {
    const raw = files("src/web").filter((f) => !f.endsWith("components/ui/input.tsx") && !f.endsWith("components/ui/phone-picker.tsx") && /<select[\s>]/.test(readFileSync(f, "utf8")));
    expect(raw).toEqual([]);
  });

  it("the ten mail selects (nine named in R41 plus the thread Move to folder) use the bare Select with a phone look of their own", () => {
    const want: [string, number][] = [
      ["src/web/pages/app/inbox-assign.tsx", 1], ["src/web/pages/app/mail/bulk-bar.tsx", 1], ["src/web/pages/app/mail/compose.tsx", 2],
      ["src/web/pages/app/mail/schedules.tsx", 1], ["src/web/pages/app/mail/splits.tsx", 2], ["src/web/pages/app/mailboxes.tsx", 1], ["src/web/pages/app/webmail.tsx", 2],
    ];
    for (const [f, n] of want) {
      const src = readFileSync(f, "utf8");
      expect((src.match(/<Select bare[\s\S]*?phoneClassName=/g) ?? []).length, f).toBeGreaterThanOrEqual(n);
    }
  });
});
