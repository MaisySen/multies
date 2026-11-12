import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/** R29: the Google sign in button follows Google's branding guidelines in light and dark, on sign in and sign up. */
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
test.skip(!!process.env.E2E_BASE_URL, "needs the local fake identity provider");
const SHOTS = `${SHOTS_ROOT}/multies-r30`;

for (const scheme of ["light", "dark"] as const) {
  test(`Google button in ${scheme} mode: Google's G asset, Google's colours, 40 px`, async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1100, height: 820 } });
    const page = await ctx.newPage();
    for (const path of ["/signup", "/login"]) {
      await page.goto(`${BASE}${path}`);
      const google = page.getByRole("button", { name: "Continue with Google" });
      await expect(google).toBeVisible();
      // R30: Google's own downloadable G asset, loaded and drawn at 20 px.
      const g = google.getByTestId("google-g");
      await expect(g).toHaveAttribute("src", "/brand/google-g.svg");
      await expect.poll(() => g.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
      const look = await google.evaluate((b) => {
        const s = getComputedStyle(b);
        const logo = b.querySelector("[data-testid=google-g]")!.getBoundingClientRect();
        const r = b.getBoundingClientRect();
        return { bg: s.backgroundColor, border: s.borderTopColor, borderWidth: s.borderTopWidth, color: s.color, size: s.fontSize, weight: s.fontWeight, height: r.height, logo: [logo.width, logo.height], logoLeft: Math.round(logo.left - r.left) };
      });
      expect(look).toMatchObject(scheme === "light"
        ? { bg: "rgb(255, 255, 255)", border: "rgb(116, 119, 117)", color: "rgb(31, 31, 31)" }
        : { bg: "rgb(19, 19, 20)", border: "rgb(142, 145, 143)", color: "rgb(227, 227, 227)" });
      expect(look).toMatchObject({ borderWidth: "1px", size: "14px", weight: "500", height: 40, logo: [20, 20] });
      // Microsoft sits in the same shell.
      const ms = await page.getByRole("button", { name: "Continue with Microsoft" }).evaluate((b) => [getComputedStyle(b).backgroundColor, b.getBoundingClientRect().height]);
      expect(ms).toEqual([look.bg, 40]);
    }
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/google-sign-in-${scheme}.png` });
    await ctx.close();
  });
}
