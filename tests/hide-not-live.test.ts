import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PLANS } from "@/shared/plans";

/** Round 17: nothing that isn't live is promised to customers, and operator notes stay with operators. */
describe("only what is live is shown", () => {
  const src = (p: string) => readFileSync(p, "utf8");

  it("plans don't promise mail apps or imports that aren't switched on", () => {
    const features = Object.values(PLANS).flatMap((p) => (p as { features?: string[] }).features ?? []);
    expect(features.join(" ")).not.toMatch(/IMAP|SMTP|import/i);
    expect(src("src/web/pages/landing.tsx")).not.toMatch(/over IMAP/);
  });

  it("Stripe test mode and test cards are for platform admins only", () => {
    const billing = src("src/web/pages/app/billing.tsx");
    expect(billing).toMatch(/paidFlow && b\.testMode && platformAdmin/);
    expect(billing).not.toMatch(/operator adds Stripe keys/);
  });

  it("no operator instructions in customer pages", () => {
    expect(src("src/web/pages/app/mail-apps.tsx")).not.toMatch(/Whoever runs this Multies/);
    expect(src("src/web/pages/app/work/forms.tsx")).not.toMatch(/Turnstile keys/);
  });

  it("the nav group everyone sees is Settings (P1 layout, was Workspace), not Admin", () => {
    expect(src("src/web/layouts/app.tsx")).toMatch(/admin: "Settings"/);
  });
});
