import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sign } from "../email-worker/src/index";

/**
 * Tools UX: before and after screenshots of the Tools screens (landing, a tool, progress, result, errors, the
 * attachment menu in a thread) at 1280 and 390, light and dark. Local only, with TOOLS_FEATURES=all and the stand in
 * engine e2e/support/tools-p2-engine.mjs (TOOLS_P2_E2E=1, E2E_BASE_URL=http://localhost:PORT).
 * UX_SHOTS=<dir> writes <UX_PREFIX>-<state>-<1280|390>-<light|dark>.png. Without UX_SHOTS it still checks the flow.
 */
const FIX = "e2e/fixtures/tools";
const SHOTS = process.env.UX_SHOTS;
const PREFIX = process.env.UX_PREFIX ?? "after";
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools P2 on and the stand in engine");
test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  const email = `toolsux${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  const r = await page.request.post("/api/auth/sign-up/email", { data: { name: "Tess Tools", email, password: "a-strong-password" } });
  expect(r.status()).toBe(200);
  const done = await page.request.post("/api/account/onboarding", { data: { name: "Tess Tools", timezone: "Australia/Sydney", locale: "en-AU", company: "Tools Test Co", workspaceTimezone: "Australia/Sydney" } });
  expect(done.status()).toBeLessThan(300);
}

async function shots(page: Page, name: string, setup?: () => Promise<void>) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    for (const [vp, w, h] of [["1280", 1280, 860], ["390", 390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      if (setup) await setup();
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `${PREFIX}-${name}-${vp}-${scheme}.png`), type: "png" });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 860 });
}
const top = (page: Page) => async () => { await page.evaluate(() => window.scrollTo(0, 0)); };
const panelTop = (page: Page) => async () => { await page.getByTestId("tools-panel").evaluate((el) => el.scrollIntoView({ block: "start" })); };

test("landing, a tool, progress, result and errors", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools");
  await expect(page.getByTestId("tools-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("tool-compress")).toBeVisible();
  await shots(page, "landing", top(page));

  // A tool with a file chosen.
  await page.getByTestId("tool-compress").click();
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await expect(page.getByTestId("tools-run")).toBeEnabled();
  await shots(page, "tool", panelTop(page));

  // Progress: hold the job as running.
  let hold = true;
  await page.route("**/api/tools/jobs/*", async (route) => {
    const url = new URL(route.request().url());
    if (!hold || route.request().method() !== "GET" || url.pathname.endsWith("/download")) return route.continue();
    const token = decodeURIComponent(url.pathname.split("/").pop()!);
    return route.fulfill({ json: { token, op: "compress", status: "running", name: "sample-a-compressed.pdf" } });
  });
  await page.getByTestId("tools-run").click();
  await expect(page.getByTestId("tools-progress")).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(9_000);
  await shots(page, "progress", panelTop(page));
  hold = false;
  await expect(page.getByTestId("tools-download")).toBeVisible({ timeout: 20_000 });
  await shots(page, "result", async () => { await page.getByTestId("tools-result").evaluate((el) => el.scrollIntoView({ block: "center" })); });
  await page.unroute("**/api/tools/jobs/*");

  // Use in another tool: the result goes back to the list, which shows only what takes it.
  await page.getByTestId("tools-chain").click();
  await expect(page.getByTestId("tools-hand")).toContainText("sample-a-compressed.pdf");
  await expect(page.getByTestId("tool-convert")).toHaveCount(0);
  await page.getByTestId("tool-protect").click();
  await expect(page.getByRole("list", { name: "Files to use" })).toContainText("sample-a-compressed.pdf");

  // A failed run.
  await page.goto("/app/tools?op=compress");
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await page.route("**/api/tools/jobs/*", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname.endsWith("/download")) return route.continue();
    const token = decodeURIComponent(url.pathname.split("/").pop()!);
    return route.fulfill({ json: { token, op: "compress", status: "failed", name: "sample-a-compressed.pdf", error: "This PDF could not be read. It may be damaged or not really a PDF." } });
  });
  await page.getByTestId("tools-run").click();
  await expect(page.getByTestId("tools-error")).toBeVisible({ timeout: 15_000 });
  await shots(page, "error", async () => { await page.getByTestId("tools-error").evaluate((el) => el.scrollIntoView({ block: "center" })); });
  await page.unroute("**/api/tools/jobs/*");

  // The wrong kind of file.
  await page.goto("/app/tools?op=compress");
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample.docx"));
  await page.waitForTimeout(400);
  await shots(page, "wrongtype", panelTop(page));
  await expect(page.getByTestId("tools-file-problem")).toContainText("sample.docx is a Word file. Compress PDF takes a PDF.");
  await page.getByTestId("tools-file-problem").getByRole("button", { name: "Use Convert to PDF" }).click();
  await expect(page).toHaveURL(/op=convert/);
  await expect(page.getByRole("list", { name: "Files to use" })).toContainText("sample.docx");

  // A tool with many options: the essential ones show, the rest fold away; on a phone nothing scrolls sideways.
  await page.goto("/app/tools?op=stamp");
  await page.getByTestId("tools-input").setInputFiles(join(FIX, "sample-a.pdf"));
  await expect(page.getByTestId("tools-more")).toBeVisible();
  await expect(page.getByTestId("tools-opt-header")).toHaveCount(0);
  await shots(page, "options", top(page));
  for (const url of ["/app/tools", "/app/tools?op=stamp"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await expect(page.getByTestId("tools-page")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), url).toBeLessThanOrEqual(1);
  }
  // Search finds a tool by an everyday word, and Enter opens it.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools");
  await page.getByTestId("tools-search").fill("smaller");
  await page.getByTestId("tools-search").press("Enter");
  await expect(page).toHaveURL(/op=compress/);
});

test("AI helpers fit a phone: tabs wrap, the question box stacks", async ({ page }) => {
  await signIn(page);
  await page.goto("/app/tools/ai?feature=ask");
  await expect(page.getByTestId("tools-ai")).toBeVisible({ timeout: 20_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shots(page, "ai", top(page));
});

test("the attachment Tools menu in a thread", async ({ page, context }) => {
  test.setTimeout(120_000);
  const base = test.info().project.use.baseURL!;
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.129.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const boxes = (await (await page.request.get("/api/mailboxes")).json()).mailboxes as { id: string; address: string; status: string }[];
  const key = (await (await page.request.post("/api/inbound-keys", { headers })).json()).key as { id: string; secret: string };
  const tag = Math.random().toString(36).slice(2, 6);
  const b64 = (f: string) => readFileSync(join(FIX, f)).toString("base64").replace(/.{76}/g, "$&\r\n");
  const part = (name: string, f: string) => ["--b1", `Content-Type: application/pdf; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", b64(f)];
  let box: { id: string; address: string } | undefined;
  for (const b of boxes.filter((x) => x.status === "active")) {
    const raw = [
      "From: Pat Lee <pat.lee@example.org>", `To: ${b.address}`, `Subject: Signed lease ${tag}`,
      `Message-ID: <lease.${tag}.${b.id}@example.org>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "",
      "Hi, the lease and the schedule are attached.", "",
      ...part("Lease agreement 2026 final version signed.pdf", "sample-a.pdf"), ...part("Schedule A.pdf", "sample-b.pdf"), "--b1--", "",
    ].join("\r\n");
    const body = new TextEncoder().encode(raw);
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(key.secret, ts, "pat.lee@example.org", b.address, body.buffer as ArrayBuffer);
    const posted = await page.request.post("/api/inbound/cloudflare", {
      headers: { "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": "pat.lee@example.org", "x-mymail-envelope-to": b.address, "x-mymail-signature": signature },
      data: Buffer.from(body),
    });
    if ((await posted.json()).action === "accept") { box = b; break; }
  }
  expect(box).toBeTruthy();
  let msg: { id: string; threadId: string; subject: string } | undefined;
  for (const folder of ["inbox", "spam"]) {
    const list = (await (await page.request.get(`/api/mail/messages?mailboxId=${box!.id}&folder=${folder}`)).json()).messages as { id: string; subject: string; threadId: string }[];
    msg ??= list.find((m) => m.subject === `Signed lease ${tag}`);
  }
  expect(msg).toBeTruthy();
  await page.goto(`/app/inbox?thread=${encodeURIComponent(msg!.threadId)}`);
  await expect(page.getByTestId("attachment-tools").first()).toBeVisible({ timeout: 20_000 });
  const open = async () => {
    await page.keyboard.press("Escape");
    await page.getByTestId("attachment-tools").first().scrollIntoViewIfNeeded();
    await page.getByTestId("attachment-tools").first().click();
    await expect(page.getByRole("menuitem", { name: "Compress PDF" })).toBeVisible();
  };
  await open();
  await shots(page, "menu", open);
  // More tools opens the Tools page with the attachment chosen.
  await open();
  const more = page.getByRole("menuitem", { name: "More tools" });
  if (await more.count()) {
    await more.click();
    await expect(page.getByTestId("tools-page")).toBeVisible();
    await shots(page, "menu-more", top(page));
  }
});
