import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R26 (MB-87) share links end to end: make a doc, press Share, create a link, open it signed out (read only,
 * no comments, mentions as names), then revoke it in the sheet and see the inactive page with a 404.
 */
let visitor = 0;
const ip = () => `10.126.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = "/home/user/tab/files/multies-r26";

test("share a doc read only, open it signed out, revoke it", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 860 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `olive-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  await page.request.patch("/api/org", { data: { name: "Harbour Coffee" }, headers });
  const content = {
    type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "What we are building" }] },
      { type: "paragraph", content: [{ type: "text", text: "A new home page for the spring blend, with online ordering and a store finder. " }, { type: "text", text: "@Kiran Rao" }, { type: "text", text: " owns the copy." }] },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Timeline" }] },
      { type: "bulletList", content: ["Design review on 3 November", "Copy final on 10 November", "Launch on 17 November"].map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Checklist" }] },
      { type: "taskList", content: [["Brand colours agreed", true], ["Photos of the roastery", true], ["Store finder data", false]].map(([t, done]) => ({ type: "taskItem", attrs: { checked: done }, content: [{ type: "paragraph", content: [{ type: "text", text: t as string }] }] })) },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep it warm and simple. One clear button: Order now." }] }] },
    ],
  };
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Spring website brief", content }, headers })).json()).doc as { id: string };

  await page.goto(`/app/docs/${doc.id}`);
  await page.getByTestId("share-button").click();
  await expect(page.getByTestId("share-sheet")).toBeVisible();
  await page.getByTestId("share-create").click();
  const url = (await page.getByTestId("share-url").textContent())!.trim();
  expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);
  await expect(page.getByTestId("share-link-row")).toHaveCount(1);

  // Signed out, in a fresh browser: the doc, read only.
  const anon = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme: "light", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const pub = await anon.newPage();
  const res = await pub.goto(url);
  expect(res!.status()).toBe(200);
  expect(res!.headers()["x-robots-tag"]).toContain("noindex");
  expect(res!.headers()["cache-control"]).toBe("private, max-age=0");
  await expect(pub.getByRole("heading", { name: "Spring website brief" })).toBeVisible();
  await expect(pub.getByText("Shared by Harbour Coffee")).toBeVisible();
  await expect(pub.getByText("Launch on 17 November")).toBeVisible();
  expect(await pub.locator("[contenteditable]").count()).toBe(0);
  mkdirSync(SHOTS, { recursive: true });
  await pub.screenshot({ path: `${SHOTS}/share-doc.png`, fullPage: true });

  // Revoke in the sheet: the page says the link is no longer active, with a 404.
  await page.getByRole("button", { name: "Revoke link" }).click();
  await expect(page.getByTestId("share-link-row")).toHaveCount(0);
  const gone = await pub.goto(url);
  expect(gone!.status()).toBe(404);
  await expect(pub.getByRole("heading", { name: "This link is no longer active" })).toBeVisible();
  await expect(pub.getByText("Spring website brief")).toHaveCount(0);
  await anon.close();

  // A board link: the Share button sits in the board header; the page shows columns and cards, never notes.
  const project = (await (await page.request.post("/api/projects", { data: { name: "Spring website", key: "WEB" }, headers })).json()).project as { id: string };
  const meId = (await (await page.request.get("/api/account/me")).json()).user.id as string;
  const cards: [string, string, string[], string | null, boolean][] = [
    ["Design the home page", "doing", ["design"], "2026-11-03", true], ["Write the about page", "todo", ["copy"], "2026-11-10", true],
    ["Store finder data", "todo", [], null, false], ["Order button and checkout", "doing", ["dev", "shop"], "2026-11-12", true],
    ["Photos of the roastery", "done", ["design"], null, true], ["Pick the domain", "done", [], null, false],
  ];
  for (const [title, status, labels, due, mine] of cards) await page.request.post("/api/tasks", { data: { projectId: project.id, title, status, labels, due: due ?? undefined, notes: "PRIVATE NOTE", assignee: mine ? `member:${meId}` : undefined }, headers });
  await page.goto(`/app/tasks?project=${project.id}&view=board`);
  await page.getByTestId("share-button").click();
  await page.getByTestId("share-create").click();
  const boardUrl = (await page.getByTestId("share-url").textContent())!.trim();
  const anon2 = await browser.newContext({ viewport: { width: 1270, height: 600 }, colorScheme: "light", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const pub2 = await anon2.newPage();
  expect((await pub2.goto(boardUrl))!.status()).toBe(200);
  await expect(pub2.getByText("Order button and checkout")).toBeVisible();
  await expect(pub2.getByText("PRIVATE NOTE")).toHaveCount(0);
  await pub2.screenshot({ path: `${SHOTS}/share-board.png` });
  await anon2.close();
  await ctx.close();
});
