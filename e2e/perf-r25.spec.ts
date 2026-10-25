import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R25 API speed end to end: the task list renders from the faster reads, a renamed status shows at
 * once (the status read cache clears on the write), a custom formula field change shows on the next
 * list, and the projects list answers 304 to a matching ETag and 200 once it changes.
 */
let visitor = 0;
const ip = () => `10.125.${test.info().workerIndex % 200}.${++visitor}`;

test("task list after a status rename and a formula change, and a 304 for an unchanged project list", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 860 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Petra Speed", email: `petra-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const me = (await (await page.request.get("/api/account/me")).json()) as { user: { id: string } };
  const project = (await (await page.request.post("/api/projects", { data: { name: "Website relaunch", key: "WEB" }, headers })).json()).project as { id: string; statuses: { id: string; name: string; category: string; color: string }[] };

  // ETag on the projects list: a match is a 304 with no body.
  const first = await page.request.get("/api/projects");
  const etag = first.headers()["etag"];
  expect(etag).toBeTruthy();
  expect(first.headers()["cache-control"]).toBe("private, no-cache");
  const same = await page.request.get("/api/projects", { headers: { "if-none-match": etag } });
  expect(same.status()).toBe(304);

  const field = (await (await page.request.post("/api/fields", { data: { projectId: project.id, name: "Effort", type: "formula", config: { expression: "points * 2" } }, headers })).json()).field as { id: string };
  const seed: [string, number, string][] = [
    ["Design the new pricing page", 5, "high"], ["Write launch announcement", 3, "medium"], ["Accessibility pass on forms", 3, "medium"],
    ["Set up redirects", 2, "low"], ["Refresh product screenshots", 1, "low"], ["Update help centre links", 1, "none"],
  ];
  const ids: string[] = [];
  for (const [title, points, priority] of seed) {
    const r = await page.request.post("/api/tasks", { data: { title, projectId: project.id, points, priority, assignee: `member:${me.user.id}` }, headers });
    expect(r.status()).toBe(201);
    ids.push((await r.json()).task.id);
  }
  const listed = async () => (await (await page.request.get(`/api/tasks?projectId=${project.id}`)).json()).tasks as { id: string; statusName: string; fields: Record<string, unknown> }[];
  expect((await listed()).find((t) => t.id === ids[0])!.fields[field.id]).toBe(10);

  // The project list changed (a field and tasks), so the old tag is a 200 now.
  expect((await page.request.get("/api/projects", { headers: { "if-none-match": etag } })).status()).toBe(200);

  await page.goto(`/app/tasks?view=list&project=${project.id}`);
  await expect(page.getByText("Design the new pricing page").first()).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "Status" }).filter({ hasText: /^To do$/ }).first()).toBeVisible();

  // Rename "To do" to "Up next": the next list shows it at once.
  const statuses = project.statuses.map((s) => (s.name === "To do" ? { ...s, name: "Up next" } : s));
  expect((await page.request.patch(`/api/projects/${project.id}`, { data: { statuses }, headers })).status()).toBe(200);
  expect((await listed()).every((t) => t.statusName === "Up next")).toBe(true);
  // A formula change shows on the next list too.
  expect((await page.request.patch(`/api/fields/${field.id}`, { data: { config: { expression: "points * 3" } }, headers })).status()).toBe(200);
  expect((await listed()).find((t) => t.id === ids[0])!.fields[field.id]).toBe(15);

  await page.reload();
  await expect(page.getByRole("gridcell", { name: "Status" }).filter({ hasText: /^Up next$/ }).first()).toBeVisible();
  await expect(page.getByText("Refresh product screenshots").first()).toBeVisible();
  mkdirSync("/home/user/tab/files/multies-r25", { recursive: true });
  await page.screenshot({ path: "/home/user/tab/files/multies-r25/r25-perf.png" });
  await ctx.close();
});
