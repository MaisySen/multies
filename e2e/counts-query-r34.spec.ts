import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/** R34: unread counts (ETag 304), the task query with OR, brackets and history, and old refs after a key edit and a move. */
let visitor = 0;
const ip = () => `10.134.${test.info().workerIndex % 200}.${++visitor}`;

async function owner(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return headers;
}

test("counts answer 304 when nothing moved; the query takes OR, brackets and history; old refs keep working", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = await owner(page);
  const first = await page.request.get("/api/counts", { headers });
  expect(first.status()).toBe(200);
  const body = await first.json();
  expect(Object.keys(body).sort()).toEqual(["at", "chat", "mail", "notifications", "tasks", "triage"]);
  const etag = first.headers()["etag"];
  expect((await page.request.get("/api/counts", { headers: { ...headers, "if-none-match": etag } })).status()).toBe(304);

  const ops = (await (await page.request.post("/api/projects", { data: { name: "Ops", key: "OPS" }, headers })).json()).project;
  const mb = (await (await page.request.post("/api/projects", { data: { name: "Build", key: "MB" }, headers })).json()).project;
  const doing = ops.statuses.find((s: { category: string }) => s.category === "doing").id;
  const a = (await (await page.request.post("/api/tasks", { data: { title: "Rotate keys", projectId: ops.id, labels: ["security"] }, headers })).json()).task;
  const b = (await (await page.request.post("/api/tasks", { data: { title: "Renew cert", projectId: ops.id, labels: ["ops"] }, headers })).json()).task;
  await page.request.patch(`/api/tasks/${a.id}`, { data: { statusId: doing }, headers });
  const find = async (q: string) => ((await (await page.request.get(`/api/tasks?q=${encodeURIComponent(q)}`, { headers })).json()).tasks as { title: string }[]).map((t) => t.title).sort();
  expect(await find("label:security OR label:ops")).toEqual(["Renew cert", "Rotate keys"]);
  expect(await find("status WAS doing")).toEqual(["Rotate keys"]);
  expect(await find("(label:ops OR label:security) -status CHANGED")).toEqual(["Renew cert"]);
  const bad = await page.request.get(`/api/tasks?q=${encodeURIComponent("(label:ops OR label:security")}`, { headers });
  expect(bad.status()).toBe(400);

  await page.request.patch(`/api/projects/${ops.id}`, { data: { key: "PLAT" }, headers });
  expect((await (await page.request.get("/api/tasks/OPS-2", { headers })).json()).task.id).toBe(b.id);
  await page.request.patch(`/api/tasks/${a.id}`, { data: { projectId: mb.id }, headers });
  expect((await (await page.request.get("/api/tasks/PLAT-1", { headers })).json()).task.id).toBe(a.id);
  expect(await find("project:OPS")).toEqual(["Renew cert"]);

  // The query box: a missing bracket shows the message inline.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/tasks?project=${encodeURIComponent(ops.id)}`);
  const box = page.getByLabel("Search tasks");
  await box.waitFor({ state: "visible", timeout: 30_000 });
  await box.fill("(label:ops OR status WAS doing");
  await box.press("End");
  await page.locator("body").click({ position: { x: 5, y: 5 } }); // close suggestions so the message shows
  await expect(page.locator("#task-query-error")).toContainText("Expected )");
  if (!process.env.E2E_BASE_URL) {
    mkdirSync("/home/user/tab/files/multies-r34", { recursive: true });
    await page.screenshot({ path: "/home/user/tab/files/multies-r34/tasks-query-error.png" });
    await box.click();
    await box.fill("(label:ops OR label:security) AND status ");
    await expect(page.getByRole("option", { name: /WAS/ })).toBeVisible();
    await page.screenshot({ path: "/home/user/tab/files/multies-r34/tasks-query-suggest.png" });
  }
});
