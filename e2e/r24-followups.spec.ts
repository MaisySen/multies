import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R24 follow ups: a person's own weekly capacity on the workload view (set on their row, kept after a
 * reload, the load bar measured against it), and the @ mention picker in meeting notes.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.125.${test.info().workerIndex % 200}.${++visitor}` });
});
const DAY = 86_400_000;
const monday = (d = new Date()) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
const at = (base: Date, days: number) => new Date(base.getTime() + days * DAY + 12 * 3600_000).toISOString();

async function signup(page: Page, name: string) {
  const headers = { origin: new URL(test.info().project.use.baseURL!).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email: `${name.split(" ")[0].toLowerCase()}-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { headers, tag, me: (await (await page.request.get("/api/account/me")).json()).user as { id: string; name: string } };
}

test("workload: set my own weekly capacity on my row and see the load against it", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 860 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": `10.126.${test.info().workerIndex % 200}.${++visitor}` } });
  const page = await ctx.newPage();
  const { headers, me } = await signup(page, "Ada Planner");
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const wk = monday();
  for (const [title, points, day] of [["Design the pricing page", 8, 1], ["Write the launch post", 5, 2], ["Accessibility pass", 5, 3]] as const) {
    expect((await page.request.post("/api/tasks", { data: { title, projectId: project.id, points, due: at(wk, day), assignee: `member:${me.id}` }, headers })).status()).toBe(201);
  }
  await page.goto(`/app/tasks?view=workload&project=${project.id}`);
  const row = page.getByTestId("workload").locator('tr[data-person="Ada Planner"]');
  const thisWeek = wk.toISOString().slice(0, 10);
  const load = row.locator(`td[data-cell$="|${thisWeek}"]`).getByTestId("load");
  await expect(load).toHaveText("18 / 20 pts");
  await expect(row.getByTestId("capacity")).toHaveText("20 pts a week (default)");
  await row.getByTestId("capacity").click();
  await row.getByLabel("Weekly capacity in points").fill("15");
  await row.getByRole("button", { name: "Save capacity" }).click();
  await expect(load).toHaveText("18 / 15 pts");
  await expect(row.getByTestId("capacity")).toHaveText("15 pts a week");
  await page.reload();
  await expect(load).toHaveText("18 / 15 pts");
  const stored = (await (await page.request.get("/api/workload/capacity")).json()) as { people: { person: string; points: number | null }[] };
  expect(stored.people.find((p) => p.person === `member:${me.id}`)?.points).toBe(15);
  mkdirSync(`${SHOTS_ROOT}/multies-r24`, { recursive: true });
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r24/capacity.png` });
  await ctx.close();
});

test("meeting notes: type @ to pick who an action item is for", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const me = (await (await page.request.get("/api/account/me")).json()).user as { id: string; name: string };
  await page.goto("/app/meetings");
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.getByLabel("Title").fill("Weekly planning");
  await page.getByRole("button", { name: "Save without inviting" }).click();
  await expect(page).toHaveURL(/\/app\/meetings\/mtg_/);
  await page.getByTestId("open-notes").click();
  const editor = page.getByRole("textbox", { name: "Meeting notes" });
  await editor.locator('ul[data-type="taskList"] li p').first().click();
  await page.keyboard.type(`Send the deck @${me.name.slice(0, 2)}`);
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option").first()).toContainText(me.name);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r24/mention-picker.png` });
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await page.keyboard.type("due Friday");
  await expect(editor).toContainText(`Send the deck @${me.name} due Friday`);
  await expect(page.getByTestId("notes-state")).toHaveText("Saved", { timeout: 10_000 });
  await expect(page.getByLabel("Assignee for Send the deck")).toHaveValue(`member:${me.id}`, { timeout: 10_000 });
  // Escape closes the list without picking anyone.
  await page.keyboard.press("Enter");
  await page.keyboard.type("Ask @zzqq");
  await expect(picker).toBeHidden();
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
});
