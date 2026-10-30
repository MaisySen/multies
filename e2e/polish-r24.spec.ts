import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R24 polish end to end: a dashboard widget moves with its card menu (no drag), and a project
 * guest sees the project's pages as a tree with "Linked from" under an open page.
 */
let visitor = 0;
const ip = () => `10.126.${test.info().workerIndex % 200}.${++visitor}`;
const text = (t: string, href?: string) => ({ type: "text", text: t, ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}) });
const para = (...content: unknown[]) => ({ type: "paragraph", content });

test("move dashboard widgets from the card menu, and a guest sees the page tree and Linked from", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 900 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Planner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = (await (await page.request.post("/api/projects", { data: { name: "Harbour office fit out", key: "HAR" }, headers })).json()).project as { id: string };
  for (const title of ["Measure the meeting rooms", "Order the desks", "Book the movers"]) await page.request.post("/api/tasks", { data: { title, projectId: project.id }, headers });

  // Dashboards: Move down and Move up from the menu, saved across a reload.
  const made = await page.request.post("/api/dashboards", { data: { starter: "team" }, headers });
  expect(made.status()).toBe(201);
  const dash = (await made.json()).dashboard as { id: string };
  await page.goto(`/app/dashboards/${dash.id}`);
  const widgets = page.getByTestId("widget");
  await expect(widgets).toHaveCount(4);
  const titles = () => widgets.evaluateAll((els) => els.map((e) => e.getAttribute("data-title")));
  expect(await titles()).toEqual(["Tasks by status", "Open tasks by person", "Due this week and overdue", "Completed per week"]);
  await page.getByRole("button", { name: "Options for Tasks by status" }).click();
  await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Move down" }).click();
  await expect.poll(titles).toEqual(["Open tasks by person", "Tasks by status", "Due this week and overdue", "Completed per week"]);
  // Keyboard only: focus the last card's menu, open it with Enter, pick Move up.
  await page.getByRole("button", { name: "Options for Completed per week" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Move down" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Move up" }).press("Enter");
  await expect.poll(titles).toEqual(["Open tasks by person", "Tasks by status", "Completed per week", "Due this week and overdue"]);
  await expect.poll(async () => ((await (await page.request.get(`/api/dashboards/${dash.id}`)).json()).dashboard.widgets as { title: string }[]).map((w) => w.title))
    .toEqual(["Open tasks by person", "Tasks by status", "Completed per week", "Due this week and overdue"]);
  await page.reload();
  await expect.poll(titles).toEqual(["Open tasks by person", "Tasks by status", "Completed per week", "Due this week and overdue"]);

  // Docs in the project: a tree, and two pages that link to the floor plan.
  const mk = async (data: Record<string, unknown>) => (await (await page.request.post("/api/docs", { data: { projectId: project.id, ...data }, headers })).json()).doc as { id: string };
  const brief = await mk({ title: "Project brief", text: "What we are building and by when." });
  const plan = await mk({ title: "Floor plan", text: "Desks by the windows, two quiet rooms.", parentId: brief.id });
  await mk({ title: "Moving day checklist", parentId: brief.id, content: { type: "doc", content: [para(text("Check the "), text("floor plan", `/app/docs/${plan.id}`), text(" before the movers arrive."))] } });
  await mk({ title: "Supplier contacts", content: { type: "doc", content: [para(text("Desks follow the "), text("floor plan", `/app/docs/${plan.id}`), text(" layout."))] } });
  await page.request.post("/api/docs", { data: { title: "Workspace secret page", text: "Nobody outside sees this." }, headers });

  const invite = await page.request.post("/api/guests", { data: { projectId: project.id, email: `maria-${tag}@example.com`, name: "Maria" }, headers });
  expect(invite.status()).toBe(201);
  const url = (await invite.json()).inviteUrl as string;
  const gctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 820 }, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const guest = await gctx.newPage();
  await guest.goto(new URL(url).pathname);
  await expect(guest).toHaveURL(/\/guest$/);
  const tree = guest.getByTestId("guest-doc-tree");
  await expect(tree.getByRole("treeitem", { name: "Project brief" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Project brief" }).getByRole("treeitem", { name: "Floor plan" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Supplier contacts" })).toBeVisible();
  await expect(tree.getByText("Workspace secret page")).toHaveCount(0);
  // Collapse and expand.
  await tree.getByRole("button", { name: "Collapse Project brief" }).click();
  await expect(tree.getByRole("treeitem", { name: "Floor plan" })).toHaveCount(0);
  await tree.getByRole("button", { name: "Expand Project brief" }).click();
  await tree.getByRole("treeitem", { name: "Floor plan" }).getByRole("button", { name: "Floor plan" }).click();
  const linked = guest.getByTestId("guest-backlinks");
  await expect(linked.getByRole("button", { name: /Moving day checklist/ })).toBeVisible();
  await expect(linked.getByRole("button", { name: /Supplier contacts/ })).toBeVisible();
  await expect(linked).toContainText("before the movers arrive");
  mkdirSync("/home/user/tab/files/multies-r24", { recursive: true });
  await guest.screenshot({ path: "/home/user/tab/files/multies-r24/polish.png" });
  // Follow a backlink; a page nobody links to says so.
  await linked.getByRole("button", { name: /Supplier contacts/ }).click();
  await expect(guest.getByRole("heading", { name: "Supplier contacts" })).toBeVisible();
  await expect(guest.getByTestId("guest-backlinks")).toContainText("No other page in this project links here yet.");
  // The guest endpoints stay inside the project.
  const secret = ((await (await page.request.get("/api/docs")).json()).docs as { id: string; title: string }[]).find((d) => d.title === "Workspace secret page")!;
  expect((await guest.request.get(`/api/guest/r24/docs/${secret.id}/backlinks`)).status()).toBe(404);
  await gctx.close();
  await ctx.close();
});
