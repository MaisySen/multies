import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R33 (helper d1): a project key edit to a key another project uses is refused inline under the Key field;
 * a free key saves and the board refs use it, and the old ref still opens the task.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.83.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

test("a taken key is refused under the field; a free key saves and old refs still open", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  await page.request.post("/api/projects", { headers, data: { name: "Operations", key: "OPSX" } });
  const project = (await (await page.request.post("/api/projects", { headers, data: { name: "Sales pipeline", key: "SALX" } })).json()).project as { id: string };
  const task = (await (await page.request.post("/api/tasks", { headers, data: { title: "Keep my link", projectId: project.id } })).json()).task as { id: string; ref: string };
  expect(task.ref).toBe("SALX-1");

  await page.goto(`/app/tasks?project=${project.id}`);
  await page.getByRole("button", { name: "Project settings" }).click();
  const key = page.getByTestId("project-key");
  await expect(key).toHaveValue("SALX");
  await key.fill("opsx");
  await expect(key).toHaveValue("OPSX");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("The key OPSX is already used by Operations. Pick another key.")).toBeVisible();
  await expect(key).toHaveAttribute("aria-invalid", "true");
  mkdirSync(`${SHOTS_ROOT}/multies-r33`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r33/projects-key-taken.png` });

  await key.fill("REVX");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("The key OPSX is already used")).toHaveCount(0);
  await expect.poll(async () => ((await (await page.request.get(`/api/tasks/${task.id}`)).json()).task ?? {}).ref).toBe("REVX-1");
  const old = await page.request.get("/api/tasks/SALX-1");
  expect(old.status()).toBe(200);
  expect(((await old.json()).task as { id: string }).id).toBe(task.id);
});
