import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R38 dashboard shots: the same seeded dashboard and the add widget picker, desktop and phone, light
 * and dark. SHOT_PHASE=before or after names the files; the after phase also adds the R38 widgets.
 */
const DIR = "/home/user/tab/files/multies-r38";
const PHASE = process.env.SHOT_PHASE ?? "after";
const DAY = 86_400_000;
let visitor = 0;
const ip = () => `10.138.${test.info().workerIndex % 200}.${++visitor}`;

test.skip(!process.env.SHOT_PHASE, "screenshots only when SHOT_PHASE is set");

async function seed(page: Page, headers: Record<string, string>) {
  const me = (await (await page.request.get("/api/account/me")).json()) as { user: { id: string } };
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string };
  const today = new Date(); today.setUTCHours(23, 0, 0, 0);
  const rows: [string, Record<string, unknown>, string?][] = [
    ["Design the pricing page", { due: new Date(today.getTime() - 3 * DAY).toISOString(), priority: "high", assignee: `member:${me.user.id}` }],
    ["Fix the signup form", { due: new Date(today.getTime() - 1 * DAY).toISOString(), priority: "urgent" }, "doing"],
    ["Write the launch post", { due: today.toISOString(), assignee: `member:${me.user.id}` }, "doing"],
    ["Plan the webinar", { assignee: `member:${me.user.id}`, priority: "medium" }],
    ["Refresh screenshots", { priority: "low" }, "done"],
    ["Update the help center", { assignee: `member:${me.user.id}` }, "done"],
    ["Check analytics events", { priority: "high" }, "done"],
    ["Brief the agency", {}],
  ];
  const ids: string[] = [];
  for (const [title, extra, status] of rows) {
    const r = await page.request.post("/api/tasks", { data: { title, projectId: project.id, ...extra }, headers });
    expect(r.status()).toBe(201);
    const id = (await r.json()).task.id as string;
    ids.push(id);
    if (status) expect((await page.request.patch(`/api/tasks/${id}`, { data: { status }, headers })).status()).toBe(200);
  }
  for (const [i, min] of [[0, 90], [1, 45], [2, 120], [3, 30]] as const) {
    await page.request.post("/api/time", { data: { taskId: ids[i], minutes: min, date: new Date(Date.now() - i * DAY).toISOString().slice(0, 10) }, headers });
  }
  return project;
}

test(`dashboard shots (${PHASE})`, async ({ browser }) => {
  test.setTimeout(240_000);
  mkdirSync(DIR, { recursive: true });
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = await seed(page, headers);
  const made = await page.request.post("/api/dashboards", { data: { starter: "team" }, headers });
  const dash = (await made.json()).dashboard as { id: string; widgets: unknown[] };
  if (PHASE === "after") {
    const extra = [
      { type: "calculation", metric: "done", range: "30d", goal: 10 },
      { type: "battery", source: { projectId: project.id } },
      { type: "pivot", groupBy: "assignee", columnBy: "status", size: 2 },
      { type: "created_completed", range: "30d", size: 2 },
      { type: "task_list", sort: "priority" },
      { type: "time_tracked", range: "7d" },
      { type: "note", text: "Launch week. Keep the overdue list at zero and log your time on launch tasks." },
    ];
    expect((await page.request.patch(`/api/dashboards/${dash.id}`, { data: { widgets: [...extra, ...dash.widgets] }, headers })).status()).toBe(200);
  }
  for (const [w, h, dev] of [[1440, 1000, "desktop"], [390, 844, "phone"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(`/app/dashboards/${dash.id}`);
      await expect(page.getByTestId("widget").first()).toBeVisible();
      await page.waitForTimeout(900);
      // The app scrolls inside its main pane, so a tall window shows the whole grid on desktop.
      if (dev === "desktop") await page.setViewportSize({ width: w, height: PHASE === "after" ? 2350 : h });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${DIR}/dashboard-${PHASE}-grid-${dev}-${scheme}.png` });
      await page.setViewportSize({ width: w, height: h });
      await page.getByRole("button", { name: "Add widget" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${DIR}/dashboard-${PHASE}-picker-${dev}-${scheme}.png` });
      await page.keyboard.press("Escape");
    }
  }
  await ctx.close();
});
