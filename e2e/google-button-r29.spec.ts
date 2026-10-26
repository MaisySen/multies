import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/** R29: the Google sign in button follows Google's branding guidelines in light and dark, on sign in and sign up. */
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
test.skip(!!process.env.E2E_BASE_URL, "needs the local fake identity provider");
const SHOTS = "/home/user/tab/files/multies-r29";

for (const scheme of ["light", "dark"] as const) {
  test(`Google button in ${scheme} mode: the four colour G, Google's colours, 40 px`, async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1100, height: 820 } });
    const page = await ctx.newPage();
    for (const path of ["/signup", "/login"]) {
      await page.goto(`${BASE}${path}`);
      const google = page.getByRole("button", { name: "Continue with Google" });
      await expect(google).toBeVisible();
      const fills = await google.locator("svg path").evaluateAll((ps) => ps.map((p) => p.getAttribute("fill")));
      expect(fills).toEqual(["#EA4335", "#4285F4", "#FBBC05", "#34A853", "none"]);
      const look = await google.evaluate((b) => {
        const s = getComputedStyle(b);
        const logo = b.querySelector("svg")!.getBoundingClientRect();
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
