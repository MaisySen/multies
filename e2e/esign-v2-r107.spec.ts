import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R107 e-sign v2: the signer's email code, consent, order vs parallel, decline, a closed link, another signer's
 * link, used and wrong codes, templates for a member vs an admin, and the public check page; shots at 1280 and
 * 390 in light, dark and Forest with axe. Local only: SIGN_E2E=1 E2E_BASE_URL=http://localhost:PORT, the server
 * started with Tools on (TOOLS_FEATURES share,esign, ESIGN_V2 on), DOC_ENGINE_URL at e2e/support/sign-engine.mjs,
 * and SIGN_OUTBOX naming the server's OUTBOX_DIR (codes and links are read from the local outbox; every address
 * is an example.com one and nothing leaves the machine).
 */
test.skip(process.env.SIGN_E2E !== "1", "needs a local server with Tools on and the stand in engine");
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);
const OUTBOX = process.env.SIGN_OUTBOX ?? ".data/sign-e2e-outbox";
const SHOTS = process.env.SIGN_SHOTS;
const PDF = readFileSync("e2e/fixtures/tools/sample-a.pdf");

function mails(to: string): string[] {
  if (!existsSync(OUTBOX)) return [];
  return readdirSync(OUTBOX).sort().map((f) => readFileSync(join(OUTBOX, f), "utf8")).filter((s) => s.includes(to));
}
const linksTo = (to: string) => mails(to).map((m) => m.match(/\/sign\/[A-Za-z0-9_-]{43}/)?.[0]).filter((x): x is string => !!x);
const codeTo = (to: string) => [...mails(to)].reverse().map((m) => m.match(/Your code is (\d{6})/)?.[1]).find(Boolean) ?? "";

async function axe(page: Page, where: string, include = "main, .card, body") {
  await page.waitForTimeout(250);
  const { violations } = await new AxeBuilder({ page }).include(include.split(", ")[0] === "main" && (await page.locator("main").count()) ? "main" : "body").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `r107-${name}.png`), fullPage: false });
}
/** Shots and axe in light and dark at 1280 and 390 (Forest is a workspace brand: the app pages get it below). */
async function views(page: Page, name: string) {
  const bad: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await shot(page, `${name}-${w}-${scheme}`);
      bad.push(...(await axe(page, `${name} ${w} ${scheme}`)));
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 860 });
  return bad;
}

/** Confirms the address from the local outbox (the shared helper skips when E2E_BASE_URL is set). */
async function confirmEmail(req: APIRequestContext, address: string) {
  const find = () => [...mails(address)].reverse().map((s) => JSON.parse(s) as { subject: string; text: string }).find((m) => m.subject.includes("Confirm your email"));
  await expect.poll(() => !!find(), { timeout: 15_000 }).toBe(true);
  const res = await req.get(find()!.text.match(/https?:\/\/\S+/)![0], { maxRedirects: 0 });
  expect(res.status(), `confirm ${address}`).toBeLessThan(400);
}

async function signUp(req: APIRequestContext, email: string, name: string, company: string) {
  expect((await req.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" } })).status()).toBe(200);
  if (company) await confirmEmail(req, email);
  if (company) expect((await req.post("/api/account/onboarding", { data: { name, timezone: "Australia/Sydney", locale: "en-AU", company, workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
}
async function draft(req: APIRequestContext) {
  const r = await req.post("/api/tools/esign/documents", { multipart: { file: { name: "Contract.pdf", mimeType: "application/pdf", buffer: PDF } }, headers: { "x-multies-upload": "1" } });
  expect(r.status(), await r.text()).toBe(201);
  const id = (await r.json()).id as string;
  await expect.poll(async () => (await (await req.get(`/api/tools/esign/${id}/pages`)).json()).status, { timeout: 20_000 }).toBe("done");
  return id;
}
const FIELDS = [
  { signer: 0, kind: "signature", page: 1, x: 60, y: 640, w: 180, h: 50 },
  { signer: 0, kind: "text", page: 1, x: 320, y: 650, w: 160, h: 24, label: "Job title" },
  { signer: 1, kind: "signature", page: 1, x: 60, y: 720, w: 180, h: 50 },
  { signer: 1, kind: "checkbox", page: 1, x: 320, y: 730, w: 20, h: 20, label: "I accept the terms" },
];
let n = 0;
async function send(req: APIRequestContext, order: "any" | "sequence") {
  const id = await draft(req);
  let mailboxId = ((await (await req.get("/api/mailboxes")).json()).mailboxes as { id: string }[])[0]?.id;
  if (!mailboxId) {
    const fa = await req.post("/api/free-address", { data: { localPart: `sender${Date.now() % 1e8}`, displayName: "Sam Sender" } });
    expect(fa.status(), await fa.text()).toBe(201);
    mailboxId = (await fa.json()).mailbox.id as string;
  }
  n += 1;
  const people = [{ name: "Bob Builder", email: `bob${n}-${Date.now()}@example.com` }, { name: "Cara Lee", email: `cara${n}-${Date.now()}@example.com` }];
  const r = await req.post(`/api/tools/esign/${id}/send`, { data: { signers: people, order, fields: FIELDS, mailboxId, message: "Please sign by Friday", expiresDays: 7, remindDays: 0 } });
  expect(r.status(), await r.text()).toBe(200);
  return { id, bob: people[0].email, cara: people[1].email };
}
async function verifyCode(page: Page, email: string) {
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.locator("#code")).toBeVisible();
  await expect.poll(() => codeTo(email), { timeout: 10_000 }).toMatch(/^\d{6}$/);
  await page.locator("#code").fill(codeTo(email));
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.locator("#sign-app")).toBeVisible({ timeout: 10_000 });
}

test("signer flow in order: code, consent, fields; the next signer only after; finished copy checks out on the check page", async ({ page, browser, baseURL }) => {
  await signUp(page.request, `sender-${Date.now()}@example.com`, "Sam Sender", "Sign Test Co");
  const { id, bob, cara } = await send(page.request, "sequence");
  expect(linksTo(cara)).toHaveLength(0);
  const [bl] = linksTo(bob);
  const signer = await (await browser.newContext({ baseURL })).newPage();
  await signer.goto(bl);
  await expect(signer.locator("#idv-app")).toBeVisible();
  await expect(signer.locator("body")).not.toContainText(cara);
  const bad = await views(signer, "signer-code");
  await verifyCode(signer, bob);
  // Used code: the same code again is refused (the link is now checked, but the code itself is spent).
  const ft = await signer.locator("#sign-app").getAttribute("data-ft");
  const reuse = await signer.request.post(bl, { data: { ft, action: "code_check", code: codeTo(bob) }, headers: { origin: new URL(signer.url()).origin } });
  expect(reuse.status()).toBe(409);
  bad.push(...(await views(signer, "signer-sign")));
  await expect(signer.getByRole("button", { name: "Sign", exact: true })).toBeDisabled();
  await signer.getByRole("tab", { name: "Type", exact: true }).click();
  await signer.locator("#typed-name").fill("Bob Builder");
  await signer.getByLabel("Job title").fill("Site manager");
  await expect(signer.getByRole("button", { name: "Sign", exact: true })).toBeDisabled();
  await signer.locator("#agree").check();
  await signer.setViewportSize({ width: 390, height: 844 });
  await shot(signer, "signer-ready-390-light");
  await signer.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(signer.locator("body")).toContainText(/you signed|signed it|thank/i, { timeout: 10_000 });
  await shot(signer, "signer-done-390-light");
  // Cara's turn now.
  await expect.poll(() => linksTo(cara).length, { timeout: 10_000 }).toBe(1);
  const [cl] = linksTo(cara);
  await signer.goto(cl);
  await verifyCode(signer, cara);
  await signer.getByRole("tab", { name: "Type", exact: true }).click();
  await signer.locator("#typed-name").fill("Cara Lee");
  await signer.getByLabel("I accept the terms").check();
  await signer.locator("#agree").check();
  await signer.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(signer.locator("body")).toContainText(/everyone has signed|you signed|signed it/i, { timeout: 10_000 });
  // The request completes and is sealed; the finished copy matches on the public check page.
  await expect.poll(async () => (await (await page.request.get(`/api/tools/esign/${id}`)).json()).status, { timeout: 30_000 }).toBe("completed");
  const file = await (await page.request.get(`/api/tools/esign/${id}/download`)).body();
  const tmp = join(SHOTS ?? "/tmp", `r107-signed-${Date.now()}.pdf`);
  mkdirSync(SHOTS ?? "/tmp", { recursive: true });
  writeFileSync(tmp, file);
  const rec = await (await page.request.get(`/api/tools/esign/${id}/record`)).json();
  expect(rec.seal?.valid).toBe(true);
  expect(rec.events.some((e: { ip_hash: string | null; time_zone: string | null }) => e.ip_hash && e.time_zone)).toBe(true);
  const pub = await (await browser.newContext({ baseURL })).newPage();
  await pub.goto("/sign/verify");
  await pub.locator("#vf").setInputFiles(tmp);
  await expect(pub.locator("#result")).toContainText("Unchanged since signing", { timeout: 10_000 });
  await expect(pub.locator("#result")).toContainText("Contract");
  bad.push(...(await views(pub, "verify-match")));
  const changed = tmp.replace(/\.pdf$/, "-changed.pdf");
  writeFileSync(changed, Buffer.concat([file, Buffer.from(" ")]));
  await pub.locator("#vf").setInputFiles(changed);
  await expect(pub.locator("#result")).toContainText("No match", { timeout: 10_000 });
  await shot(pub, "verify-nomatch-390-light");
  // The sender's request page: badges and the record button.
  await page.goto(`/app/tools/sign?request=${id}`);
  await expect(page.getByTestId("sign-record-download")).toBeVisible();
  bad.push(...(await views(page, "request-record")));
  expect(bad).toEqual([]);
});

test("parallel: both get links at once; decline closes it for the other; another signer's form token is refused; a wrong code counts down", async ({ page, browser, baseURL }) => {
  await signUp(page.request, `sender2-${Date.now()}@example.com`, "Sam Sender", "Sign Test Two");
  const { id, bob, cara } = await send(page.request, "any");
  expect(linksTo(bob)).toHaveLength(1);
  expect(linksTo(cara)).toHaveLength(1);
  const s = await (await browser.newContext({ baseURL })).newPage();
  await s.goto(linksTo(bob)[0]);
  const bobFt = await s.locator("#idv-app").getAttribute("data-ft");
  const origin = new URL(s.url()).origin;
  // Bob's form token cannot act on Cara's link.
  expect((await s.request.post(linksTo(cara)[0], { data: { ft: bobFt, action: "code_send" }, headers: { origin } })).status()).toBe(403);
  // Wrong code: the page says how many tries are left.
  await s.getByRole("button", { name: "Email me a code" }).click();
  await expect.poll(() => codeTo(bob), { timeout: 10_000 }).toMatch(/^\d{6}$/);
  await s.locator("#code").fill(codeTo(bob) === "000000" ? "111111" : "000000");
  await s.getByRole("button", { name: "Confirm" }).click();
  await expect(s.locator("#status")).toContainText("tries left");
  await shot(s, "signer-wrong-code-1280-light");
  await s.locator("#code").fill(codeTo(bob));
  await s.getByRole("button", { name: "Confirm" }).click();
  await expect(s.locator("#sign-app")).toBeVisible({ timeout: 10_000 });
  await s.locator("#decline-open").click();
  await s.locator("#reason").fill("The amount on page 1 is wrong");
  await s.setViewportSize({ width: 390, height: 844 });
  await shot(s, "signer-decline-390-light");
  await s.getByRole("button", { name: "Decline", exact: true }).click();
  await expect.poll(async () => (await (await page.request.get(`/api/tools/esign/${id}`)).json()).status, { timeout: 10_000 }).toBe("declined");
  await s.goto(linksTo(cara)[0]);
  await expect(s.locator("body")).toContainText(/no longer|declined|closed/i);
  await expect(s.locator("#idv-app")).toHaveCount(0);
  await shot(s, "signer-closed-390-light");
  expect(await axe(s, "closed link")).toEqual([]);
});

test("templates: an admin saves and can delete; a member sees and uses it but cannot delete; Forest", async ({ page, browser, baseURL }) => {
  const admin = `admin-${Date.now()}@example.com`;
  await signUp(page.request, admin, "Ada Admin", "Template Co");
  const id = await draft(page.request);
  const saved = await page.request.post(`/api/tools/esign/${id}/template`, { data: { name: "Service agreement", roles: ["Client", "Witness"], fields: FIELDS, order: "any", expiresDays: 14, remindDays: 0 } });
  expect(saved.status(), await saved.text()).toBe(201);
  const one = await page.request.post(`/api/tools/esign/${await draft(page.request)}/template`, { data: { name: "Contractor onboarding", roles: ["Contractor"], fields: FIELDS.slice(0, 2), order: "any", expiresDays: 14, remindDays: 0 } });
  expect(one.status()).toBe(201);
  const mEmail = `member-${Date.now()}@example.com`;
  const inv = await page.request.post("/api/team/invites", { data: { email: mEmail, role: "member" } });
  expect(inv.status(), await inv.text()).toBeLessThan(300);
  const link = (await inv.json()).link as string;
  const mctx = await browser.newContext({ baseURL });
  const m = await mctx.newPage();
  await signUp(m.request, mEmail, "Mo Member", "");
  expect((await m.request.post(`/api/invites/${link.split("/invite/")[1]}/accept`)).status()).toBe(200);
  await m.goto("/app/tools/sign");
  await m.getByRole("button", { name: "Templates" }).or(m.getByRole("tab", { name: "Templates" })).first().click();
  await expect(m.getByTestId("tpl-row")).toHaveCount(2);
  await expect(m.getByTestId("tpl-delete")).toHaveCount(0);
  await expect(m.getByTestId("tpl-use").first()).toBeVisible();
  const bad = await views(m, "templates-member");
  await page.goto("/app/tools/sign");
  await page.getByRole("button", { name: "Templates" }).or(page.getByRole("tab", { name: "Templates" })).first().click();
  await expect(page.getByTestId("tpl-delete")).toHaveCount(2);
  bad.push(...(await views(page, "templates-admin")));
  // Send to a list dialog with a pasted list.
  await page.getByTestId("tpl-row").filter({ hasText: "Contractor onboarding" }).getByTestId("tpl-bulk").click();
  await page.getByTestId("tpl-bulk-text").fill("Name, Email\nAlex Wu, alex.wu@example.com\nPriya Shah, priya.shah@example.com\nno address");
  await expect(page.getByTestId("tpl-bulk-preview")).toContainText("priya.shah@example.com");
  await shot(page, "templates-bulk-1280-light");
  bad.push(...(await axe(page, "bulk dialog", "body")));
  await page.keyboard.press("Escape");
  // Forest brand on the app pages.
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await page.goto("/app/tools/sign");
  await page.getByRole("button", { name: "Templates" }).or(page.getByRole("tab", { name: "Templates" })).first().click();
  await shot(page, "templates-1280-forest");
  bad.push(...(await axe(page, "templates forest")));
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "templates-390-forest");
  bad.push(...(await axe(page, "templates forest 390")));
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole("button", { name: "Sign a document" }).or(page.getByRole("tab", { name: "Sign a document" })).first().click();
  await shot(page, "new-1280-forest");
  await mctx.close();
  expect(bad).toEqual([]);
});
