import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Critical paths, end to end over the real UI and API: sign up and verify, send mail,
 * buy an add-on, invite a teammate, create and use an API key, export data.
 * The local server writes every email to .data/e2e-outbox (OUTBOX_DIR); against a
 * deployed environment (E2E_BASE_URL) the email based steps are skipped.
 */
const OUTBOX = ".data/e2e-outbox";
const local = !process.env.E2E_BASE_URL;

/**
 * Sign-up is limited to 5 per minute per client IP, and this suite creates more accounts
 * than that. Locally each browser context presents its own client address, the way
 * separate visitors would, so the real limits stay switched on for the run.
 */
let visitor = 0;
async function asNewVisitor(context: BrowserContext) {
  const worker = test.info().workerIndex % 200;
  if (local) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.${worker}.0.${++visitor}` });
}
test.beforeEach(async ({ context }) => asNewVisitor(context));

function lastEmailTo(address: string): { subject: string; text: string } | undefined {
  const files = readdirSync(OUTBOX).sort();
  for (const f of files.reverse()) {
    const m = JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as { to: string[]; subject: string; text: string };
    if (m.to.includes(address)) return m;
  }
  return undefined;
}

async function signUp(page: Page, name: string, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Good (morning|afternoon|evening), ${name.split(" ")[0]}`) })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/my-work$/);
}

test("sign up, then confirm the email address from the verification email", async ({ page }) => {
  test.skip(!local, "needs the local outbox");
  const email = `verify-${Date.now()}@example.com`;
  await signUp(page, "Vera Verify", email);
  await expect.poll(() => lastEmailTo(email)?.subject).toContain("Confirm your email");
  const link = lastEmailTo(email)!.text.match(/https?:\/\/\S+/)![0];
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
  await expect.poll(() => lastEmailTo(email)?.subject).toContain("Welcome to");
});

test("send a message from the demo workspace and find it in Sent", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/mail?compose=1");
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  const subject = `E2E hello ${Date.now()}`;
  await compose.getByLabel("To").fill("someone@example.com");
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByLabel("Message").fill("Sent by the end to end suite.");
  await compose.getByRole("button", { name: "Send" }).click();
  await expect(compose).toBeHidden();
  // Undo send holds the message for a few seconds; send it now instead of waiting (or leaving the page, which asks first).
  await page.getByTestId("undo-send-toast").getByRole("button", { name: "Send now" }).click();
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Sent/ }).click();
  await expect(page.getByText(subject).first()).toBeVisible();
});

test("an empty subject gets a gentle prompt that never blocks the send", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/mail?compose=1");
  const compose = page.getByRole("dialog", { name: "New message" });
  const body = `No subject ${Date.now()}`;
  await compose.getByLabel("To").fill("someone@example.com");
  await compose.getByLabel("Message").fill(body);
  await compose.getByRole("button", { name: "Send" }).click();
  const prompt = compose.getByTestId("subject-prompt");
  await expect(prompt).toContainText("Add a subject? Mail without one is more likely to go to spam.");
  if (process.env.R19_SHOTS) await page.screenshot({ path: `${process.env.R19_SHOTS}/5-subject-prompt.png` });
  await prompt.getByRole("button", { name: "Add subject" }).click();
  await expect(compose.getByLabel("Subject")).toBeFocused();
  await prompt.getByRole("button", { name: "Send anyway" }).click();
  await expect(compose).toBeHidden();
  await expect(page.getByTestId("undo-send-toast")).toBeVisible();
  await page.getByTestId("undo-send-toast").getByRole("button", { name: "Send now" }).click();
});

test("start on Free, then buy an add-on and see the new limits", async ({ page }) => {
  await signUp(page, "Paula Plan", `plan-${Date.now()}@example.com`);
  await page.goto("/app/settings/billing");
  await expect(page.getByText("Free", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("A$0, nothing to pay")).toBeVisible();
  await expect(page.getByText("0 / 1").first()).toBeVisible(); // Free includes 1 domain
  // Two extra domains: A$2 a month in total, under A$5, so it bills yearly: ten months for twelve (R62), A$20 a year.
  await page.getByRole("button", { name: "One more extra domain" }).click();
  await page.getByRole("button", { name: "One more extra domain" }).click();
  await expect(page.getByText("A$20 a year").first()).toBeVisible();
  await page.getByRole("button", { name: "Apply add-ons" }).click();
  await expect(page.getByText("Add-ons updated")).toBeVisible();
  await expect(page.getByText("0 / 3").first()).toBeVisible();
});

test("invite a teammate who signs up and joins the workspace", async ({ page, browser }) => {
  await signUp(page, "Olive Owner", `owner-${Date.now()}@example.com`);
  const mate = `mate-${Date.now()}@example.com`;
  await page.goto("/app/settings/team");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByRole("dialog").getByLabel("Email").fill(mate);
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = (await page.getByTestId("invite-link").textContent())!.trim();
  expect(link).toContain("/invite/");

  const other = await browser.newContext();
  await asNewVisitor(other);
  const p2 = await other.newPage();
  await p2.goto(link);
  await p2.getByRole("link", { name: "Create your account" }).click();
  await p2.getByLabel("Your name").fill("Mason Mate");
  await p2.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await p2.getByRole("button", { name: "Create account" }).click();
  // R39 security hotfix: the invite link alone is not enough. Until the address is confirmed, accepting is refused.
  await p2.getByRole("button", { name: "Accept and open workspace" }).click();
  await expect(p2.getByText(/Confirm your email address/).first()).toBeVisible();
  await expect(p2).toHaveURL(/\/invite\//);
  test.skip(!local, "confirming the address needs the local outbox");
  await expect.poll(() => lastEmailTo(mate)?.subject).toContain("Confirm your email");
  await p2.goto(lastEmailTo(mate)!.text.match(/https?:\/\/\S+/)![0]);
  await p2.goto(link);
  await p2.getByRole("button", { name: "Accept and open workspace" }).click();
  await expect(p2).toHaveURL(/\/app/);
  await other.close();

  await page.reload();
  await expect(page.getByRole("list", { name: "Members" }).getByText("Mason Mate")).toBeVisible();
});

test("create an API key and call the REST API with it", async ({ page, request }) => {
  await signUp(page, "Abe Api", `api-${Date.now()}@example.com`);
  await page.goto("/app/settings/developers");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("E2E");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  const secret = (await page.getByRole("dialog", { name: "Copy your API key" }).locator("code").first().textContent())!.trim();
  expect(secret).toMatch(/^mm_live_/);
  const res = await request.get("/api/v1/domains", { headers: { authorization: `Bearer ${secret}` } });
  expect(res.status()).toBe(200);
  expect((await request.get("/api/v1/domains", { headers: { authorization: "Bearer mm_live_wrongwrongwrongwrongwrong" } })).status()).toBe(401);
});

test("create an agent inbox with one API call, then act as the agent by API and MCP", async ({ page, request }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.goto("/app/settings/developers");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Agents");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  const workspaceKey = (await page.getByRole("dialog", { name: "Copy your API key" }).locator("code").first().textContent())!.trim();

  const made = await request.post("/api/v1/agents", { headers: { authorization: `Bearer ${workspaceKey}` }, data: { name: "Quote bot", localPart: "quotes" } });
  expect(made.status()).toBe(201);
  const { agent, apiKey } = await made.json();
  expect(agent.address).toMatch(/^quotes@/);
  const auth = { authorization: `Bearer ${apiKey.secret}` };
  // The agent key works for the agent and nothing else.
  expect((await request.get("/api/v1/domains", { headers: auth })).status()).toBe(403);
  const sent = await request.post(`/api/v1/agents/${agent.id}/send`, { headers: auth, data: { to: ["buyer@example.com"], subject: "Your quote", text: "A$420 for the job." } });
  expect(sent.status()).toBe(202);
  expect((await sent.json()).status).toBe("pending_approval");

  // The same agent over MCP: a JSON-RPC tool call with the agent key.
  const mcp = await request.post("/api/v1/mcp", {
    headers: { ...auth, accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_inboxes", arguments: {} } },
  });
  expect(mcp.status()).toBe(200);
  const listed = JSON.parse((await mcp.json()).result.content[0].text);
  expect(listed.agents).toEqual([expect.objectContaining({ name: "Quote bot", sentToday: 1 })]);

  await page.goto("/app/agents");
  await expect(page.getByRole("link", { name: /Quote bot/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Quote bot/ }).getByText("1 to approve")).toBeVisible();
});

test("approve an agent's message from the approval queue", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  await page.getByTestId("context-sidebar").getByRole("link", { name: /Approvals/ }).click(); // R79: the Home section sidebar
  await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Waiting (2)" })).toBeVisible();
  const card = page.getByRole("article", { name: /Re: Password reset not arriving/ });
  await card.getByRole("button", { name: "Edit" }).click();
  await card.getByLabel("Message").fill("Hi Kai,\n\nFixed on our side. Try the reset again now.\n\nNorthwind Support");
  await card.getByRole("button", { name: "Approve edited" }).click();
  await expect(page.getByText("Approved and sent").first()).toBeVisible();
  await expect(page.getByRole("tab", { name: "Waiting (1)" })).toBeVisible();
  await page.getByRole("tab", { name: "Decided" }).click();
  await expect(page.getByText("Fixed on our side. Try the reset again now.")).toBeVisible();
  // The team inbox shows the reply labelled as the agent's.
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /Password reset not arriving/ }).click();
  await expect(page.getByText("Fixed on our side. Try the reset again now.")).toBeVisible();
});

test("download a copy of my data", async ({ page }) => {
  await signUp(page, "Dana Data", `data-${Date.now()}@example.com`);
  await page.goto("/app/settings/account");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download my data" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^multies-account-.*\.json$/);
});
