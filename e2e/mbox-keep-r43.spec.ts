import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * R43: an mbox of more than one batch keeps a copy of the archive on the server after the first batch, so the
 * scheduled pass can finish the run if the page closes. With the page open it finishes as before, and the kept copy
 * is dropped at the end (the run no longer reports background).
 */
test("a multi batch mbox keeps its upload, finishes, then drops the kept copy", async ({ page }) => {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.95.${test.info().workerIndex % 200}.1` });
  const dir = join(tmpdir(), "r43-e2e"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "twenty-five.mbox");
  const stamp = Date.now();
  writeFileSync(file, Array.from({ length: 25 }, (_, i) => [
    `From sender${i}@example.com Mon Oct 26 10:00:00 2026`,
    `From: Sender ${i} <sender${i}@example.com>`, "To: you@example.com", `Subject: Kept archive ${i}`,
    `Message-ID: <r43-keep-${stamp}-${i}@example.com>`, "Date: Mon, 26 Oct 2026 10:00:00 +0000", "", `Body ${i}`, "",
  ].join("\n")).join("\n"));

  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/settings/import");
  await page.getByTestId("move-source-mbox").click();
  const keeps: { status: number; kept: boolean }[] = [];
  page.on("response", async (r) => { if (/\/mbox\/[^/]+\/keep/.test(r.url())) keeps.push({ status: r.status(), ...(await r.json().catch(() => ({}))) }); });
  await page.getByLabel("Mail archive file").setInputFiles(file);
  await page.getByTestId("mbox-start").click();
  await expect(page.getByTestId("mbox-progress")).toHaveText("Done: 25 messages brought in", { timeout: 30_000 });
  await expect.poll(() => keeps.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(keeps.every((k) => k.status === 200)).toBe(true);
  // Keep this page open stays until the background finish is proven live.
  const runs = await page.request.get("/api/data-moves");
  const body = await runs.json() as { items: { fileName: string | null; status: string; background?: boolean }[] };
  const run = body.items.find((m) => m.fileName === "twenty-five.mbox");
  expect(run?.status).toBe("done");
  expect(run?.background).toBeFalsy();
});
