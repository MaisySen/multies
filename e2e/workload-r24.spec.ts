import { test, expect, type Page } from "@playwright/test";
import { confirmEmail } from "./support/confirm-email";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R24.2 Workload end to end: two members with estimated tasks across two weeks. Open Workload, see
 * each person's load, drag a task from one person to the other (the assignee changes and stays after
 * a reload), then move one to next week with the chip's Move to menu.
 */
let visitor = 0;
const ip = () => `10.124.${test.info().workerIndex % 200}.${++visitor}`;
const DAY = 86_400_000;
const monday = (d = new Date()) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
const at = (base: Date, days: number) => new Date(base.getTime() + days * DAY + 12 * 3600_000).toISOString();

async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  const a = (await from.boundingBox())!; const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(30, b.height / 2), { steps: 12 });
  await page.mouse.up();
}

test("see each person's load per week, drag a task to a teammate and move one to next week", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const opts = { baseURL: base, viewport: { width: 1360, height: 860 }, timezoneId: "UTC" };
  const ctx = await browser.newContext({ ...opts, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const me = (await (await page.request.get("/api/account/me")).json()) as { user: { id: string } };
  const invite = (await (await page.request.post("/api/team/invites", { data: { email: `max-${tag}@example.com`, role: "member" }, headers })).json()) as { link: string };

  const ctx2 = await browser.newContext({ ...opts, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const p2 = await ctx2.newPage();
  expect((await p2.request.post("/api/auth/sign-up/email", { data: { name: "Max Builder", email: `max-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await confirmEmail(p2.request, `max-${tag}@example.com`);
  expect((await p2.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers })).status()).toBe(200);
  const max = (await (await p2.request.get("/api/account/me")).json()) as { user: { id: string } };
  await ctx2.close();

  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const wk = monday();
  const seed: [string, number, string, number][] = [
    ["Design the new pricing page", 8, me.user.id, 1], ["Write launch announcement", 5, me.user.id, 2], ["Accessibility pass on forms", 5, me.user.id, 3],
    ["Set up redirects", 3, max.user.id, 1], ["Refresh product screenshots", 2, max.user.id, 8], ["Update help centre links", 1, me.user.id, 9],
  ];
  const ids: Record<string, string> = {};
  for (const [title, points, who, day] of seed) {
    const r = await page.request.post("/api/tasks", { data: { title, projectId: project.id, points, due: at(wk, day), assignee: `member:${who}` }, headers });
    expect(r.status()).toBe(201);
    ids[title] = (await r.json()).task.id;
  }

  await page.goto(`/app/tasks?view=workload&project=${project.id}`);
  const grid = page.getByTestId("workload");
  const ada = grid.locator('tr[data-person="Ada Planner"]');
  const maxRow = grid.locator('tr[data-person="Max Builder"]');
  const thisWeek = wk.toISOString().slice(0, 10);
  const nextWeek = new Date(wk.getTime() + 7 * DAY).toISOString().slice(0, 10);
  await expect(ada.locator(`td[data-cell$="|${thisWeek}"]`).getByTestId("load")).toHaveText("18 / 20 pts");
  await expect(maxRow.locator(`td[data-cell$="|${thisWeek}"]`).getByTestId("load")).toHaveText("3 / 20 pts");
  await expect(ada.locator(`td[data-cell$="|${nextWeek}"]`).getByTestId("load")).toHaveText("1 / 20 pts");
  mkdirSync(`${SHOTS_ROOT}/multies-r23`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r23/workload.png` });

  // Drag "Write launch announcement" from Ada to Max in the same week.
  const chip = ada.locator('[data-testid="chip"]', { hasText: "Write launch announcement" }).getByRole("button", { name: /Write launch announcement/ });
  await drag(page, chip, maxRow.locator(`td[data-cell$="|${thisWeek}"]`));
  await expect(maxRow.locator(`td[data-cell$="|${thisWeek}"]`).getByTestId("load")).toHaveText("8 / 20 pts");
  await expect(ada.locator(`td[data-cell$="|${thisWeek}"]`).getByTestId("load")).toHaveText("13 / 20 pts");
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${ids["Write launch announcement"]}`)).json()).task.assignee?.id).toBe(max.user.id);
  await page.reload();
  await expect(maxRow.locator('[data-testid="chip"]', { hasText: "Write launch announcement" })).toBeVisible();
  await expect(maxRow.locator(`td[data-cell$="|${thisWeek}"]`).getByTestId("load")).toHaveText("8 / 20 pts");

  // Move "Accessibility pass on forms" to next week with the keyboard friendly menu.
  const a11y = ada.locator('[data-testid="chip"]', { hasText: "Accessibility pass on forms" });
  await a11y.getByRole("button", { name: /^Move WEB-/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^Week of \\D*${new Date(wk.getTime() + 7 * DAY).getUTCDate()}\\D*$`) }).click();
  await expect(ada.locator(`td[data-cell$="|${nextWeek}"]`).locator('[data-testid="chip"]', { hasText: "Accessibility pass on forms" })).toBeVisible();
  await expect(ada.locator(`td[data-cell$="|${nextWeek}"]`).getByTestId("load")).toHaveText("6 / 20 pts");
  const moved = (await (await page.request.get(`/api/tasks/${ids["Accessibility pass on forms"]}`)).json()).task;
  expect(moved.due.slice(0, 10)).toBe(at(wk, 10).slice(0, 10));
  await page.reload();
  await expect(ada.locator(`td[data-cell$="|${nextWeek}"]`).getByTestId("load")).toHaveText("6 / 20 pts");
  await ctx.close();
});
