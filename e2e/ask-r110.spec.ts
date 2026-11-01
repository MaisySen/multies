import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * R110 Ask (ASK_R110=on, ASK_AI_FAKE=1 in the e2e server: the AI is a local stand in). Ask with sources, empty
 * workspace, change card apply and dismiss, save to a doc, history, the daily limit, a member's view, a guest kept out
 * and a guest search link opening the guest view. SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest,
 * with axe on each.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.199.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string> };
let owner: Person, member: Person, guestCtx: BrowserContext;
let projectId = "", taskId = "", guestTaskId = "";

async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}
async function join(browser: Browser, email: string, name: string, role: "member" | "admin") {
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email, role }, headers: owner.headers })).json();
  const p = await person(browser, email, name);
  await confirmEmail(p.page.request, email);
  expect((await p.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: p.headers })).status()).toBe(200);
  return p;
}
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function askUi(page: Page, q: string) {
  await page.getByTestId("ask-box").fill(q);
  await page.getByTestId("ask-box").press("Enter");
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  owner = await person(browser, `ola-${tag}@example.com`, "Ola Owner");
  member = await join(browser, `max-${tag}@example.com`, "Max Mate", "member");
  const post = (path: string, data: unknown) => owner.page.request.post(path, { data, headers: owner.headers }).then((r) => r.json());
  projectId = (await post("/api/projects", { name: "Plover" })).project.id;
  taskId = (await post("/api/tasks", { title: "Plover launch checklist", projectId, notes: "launch is on Friday the 14th" })).task.id;
  await post("/api/docs", { title: "Plover launch brief", text: "the plover launch needs a press kit", projectId });
  guestTaskId = (await post("/api/tasks", { title: "Plover homepage copy", projectId })).task.id;
  const inv = await post("/api/guests", { projectId, email: `guest-${tag}@client.example`, name: "Gia Guest" });
  const base = test.info().project.use.baseURL!;
  guestCtx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  expect((await guestCtx.request.post("/api/guest/accept", { data: { token: String(inv.inviteUrl).split("/g/")[1] }, headers: { origin: new URL(base).origin } })).status()).toBe(200);
});
test.afterAll(async () => { for (const c of [owner?.ctx, member?.ctx, guestCtx]) await c?.close(); });

test("first visit explains Ask, and a question gets an answer with its sources and the note", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools/ask");
  await expect(page.getByTestId("ask-empty")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ask-usage")).toHaveText("15 of 15 questions left today");
  await askUi(page, "When is the plover launch?");
  const answer = page.getByTestId("ask-answer").last();
  await expect(answer).toBeVisible({ timeout: 15_000 });
  await expect(answer.getByTestId("ask-cite").first()).toBeVisible();
  await expect(answer.getByTestId("ask-source").first()).toContainText("Plover launch");
  await expect(answer.getByTestId("ask-note")).toHaveText("AI answers can be wrong. Check the sources.");
  await page.getByTestId("ask-history-open").click();
  await expect(page.getByTestId("ask-history-item").first()).toHaveText("When is the plover launch?");
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/thread=/);
});

test("nothing found spends nothing and says so", async () => {
  const page = owner.page;
  await page.goto("/app/tools/ask");
  await askUi(page, "anything about zebra crossings");
  await expect(page.getByTestId("ask-answer").last()).toHaveAttribute("data-status", "no_sources", { timeout: 15_000 });
  await expect(page.getByTestId("ask-answer").last()).toContainText("could not find anything");
  await expect(page.getByTestId("ask-usage")).toHaveText("14 of 15 questions left today");
});

test("a change card applies only on the click; dismiss changes nothing", async () => {
  const page = owner.page;
  await page.goto("/app/tools/ask");
  await askUi(page, "mark the plover launch checklist done");
  const card = page.getByTestId("ask-card").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText("Set task to Done");
  let t = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  expect(t.task.status).not.toBe("done");
  await card.getByTestId("ask-card-apply").click();
  await expect(card).toHaveAttribute("data-state", "applied", { timeout: 10_000 });
  t = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  expect(t.task.status).toBe("done");
  await askUi(page, "create a task for the press kit");
  const create = page.getByTestId("ask-card").last();
  await expect(create).toContainText("Create a task", { timeout: 15_000 });
  await create.getByTestId("ask-card-dismiss").click();
  await expect(create).toHaveAttribute("data-state", "dismissed");
  const list = await (await page.request.get(`/api/tasks?project=${projectId}`)).json();
  expect(list.tasks.some((x: { title: string }) => x.title === "Follow up from Ask")).toBe(false);
});

test("save to a doc opens a real doc", async () => {
  const page = owner.page;
  await page.getByTestId("ask-save-doc").first().click();
  await expect(page.getByTestId("ask-saved")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("ask-saved").getByRole("link", { name: "Open the doc" }).click();
  await expect(page).toHaveURL(/\/app\/docs\//);
});

test("save to a doc asks first when the answer used a private item (verifier v13, privacy)", async () => {
  const page = owner.page;
  const post = (path: string, data: unknown) => page.request.post(path, { data, headers: owner.headers }).then((r) => r.json());
  const contact = (await post("/api/contacts", { name: "Gannet Supplies", email: "hello@gannet.example" })).contact;
  await post("/api/crm/entries", { entityType: "contact", entityId: contact.id, kind: "note", body: "Gannet pricing is our private walk away number", private: true });
  await page.goto("/app/tools/ask");
  await askUi(page, "What is the gannet pricing?");
  const answer = page.getByTestId("ask-answer").last();
  await expect(answer.getByTestId("ask-source").first()).toContainText(/gannet/i, { timeout: 15_000 });
  await answer.getByTestId("ask-save-doc").click();
  const dialog = page.getByRole("dialog", { name: "Share this answer with everyone?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Everyone in the workspace can open a saved doc");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(answer.getByTestId("ask-save-doc")).toHaveText("Save to a doc");
  const docs = (await (await member.page.request.get("/api/docs", { headers: member.headers })).json()).docs as { title: string }[];
  expect(docs.some((d) => d.title.toLowerCase().includes("gannet"))).toBe(false);
});

test("history is searchable and private; the command menu asks too", async () => {
  const page = owner.page;
  await page.goto("/app/tools/ask");
  await page.getByTestId("ask-history-open").click();
  await page.getByTestId("ask-history-search").fill("when is the plover");
  await expect(page.getByTestId("ask-history-item")).toHaveCount(1);
  await member.page.goto("/app/tools/ask");
  await expect(member.page.getByTestId("ask-empty")).toBeVisible({ timeout: 20_000 });
  await member.page.getByTestId("ask-history-open").click();
  await expect(member.page.getByTestId("ask-history-empty")).toBeVisible();
  await member.page.keyboard.press("Escape");
  await member.page.keyboard.press("Control+k");
  await member.page.getByRole("combobox").first().fill("plover launch");
  await member.page.getByText("Ask AI: plover launch").click();
  await expect(member.page).toHaveURL(/\/app\/tools\/ask\?q=plover/);
  await expect(member.page.getByTestId("ask-box")).toHaveValue("plover launch");
});

test("a guest is kept out of Ask, and a guest search link opens the guest view", async () => {
  expect((await guestCtx.request.get("/api/ask/state")).status()).toBe(401);
  const r = await (await guestCtx.request.get("/api/guest/search?q=plover")).json();
  const urls: string[] = r.groups.flatMap((g: { items: { url: string }[] }) => g.items.map((i) => i.url));
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.every((u) => u.startsWith("/guest"))).toBe(true);
  const page = await guestCtx.newPage();
  await page.goto(`/guest?task=${guestTaskId}`);
  await expect(page.getByText("Plover homepage copy").first()).toBeVisible({ timeout: 20_000 });
  await page.close();
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.setTimeout(240_000);
  const page = owner.page;
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await page.goto("/app/tools/ask");
      await expect(page.getByTestId("ask-box")).toBeVisible({ timeout: 20_000 });
      await shot(page, `r110-empty-${w}-${theme}`);
      await axe(page, `empty ${w} ${theme}`);
      await page.getByTestId("ask-history-open").click();
      await shot(page, `r110-history-${w}-${theme}`);
      await axe(page, `history ${w} ${theme}`);
      await page.getByTestId("ask-history-item").last().click();
      await expect(page.getByTestId("ask-answer").first()).toBeVisible({ timeout: 10_000 });
      await shot(page, `r110-answer-${w}-${theme}`);
      await axe(page, `answer ${w} ${theme}`);
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
});

test("at the daily limit the page says so calmly and asks nothing", async () => {
  const page = owner.page;
  for (let i = 0; i < 20; i++) {
    const r = await (await page.request.post("/api/ask", { data: { question: `plover launch ${i}` }, headers: owner.headers })).json();
    if (r.message.status === "limit") break;
  }
  await page.goto("/app/tools/ask");
  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(page.getByTestId("ask-usage")).toHaveText("Daily limit reached, try again tomorrow.", { timeout: 20_000 });
  await expect(page.getByTestId("ask-submit")).toBeDisabled();
  await shot(page, "r110-limit-1280-light");
});
