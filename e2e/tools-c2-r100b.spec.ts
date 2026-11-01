import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { sign } from "../email-worker/src/index";

/**
 * R100b Tools C2 end to end, against a local server with TOOLS_FEATURES=all and the stand in engine (TOOLS_P2_E2E=1):
 * Fix a PDF wrong password, slides and drawings in the Convert hub, Link preview (the page fetch is mocked in the
 * browser; the server's private address refusal is real), Image links from a mail picture, and the Tools hub.
 * SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest.
 */
const TOOLS = "e2e/fixtures/tools";
const CONV = "e2e/fixtures/convert";
const SHOTS = process.env.SHOTS_DIR;
test.skip(process.env.TOOLS_P2_E2E !== "1", "needs a server with Tools on and the stand in engine");
test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(SHOTS ? 420_000 : 150_000); });

async function signIn(page: Page, who = "Tess") {
  const email = `r100b${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: `${who} Tools`, email, password: "a-strong-password" } })).status()).toBe(200);
  expect((await page.request.post("/api/account/onboarding", { data: { name: `${who} Tools`, timezone: "Australia/Sydney", locale: "en-AU", company: `${who} C2 Co`, workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
}
async function shots(page: Page, name: string, widths: ("1280" | "390")[] = ["1280", "390"]) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [vp, w, h] of ([["1280", 1280, 900], ["390", 390, 844]] as const).filter(([v]) => widths.includes(v))) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, `r100b-${name}-${vp}-${scheme}.png`), fullPage: true });
    }
  }
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}
async function noSeriousAxe(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(300);
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent("download"), click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}
function odf(kind: "graphics" | "presentation"): Buffer {
  return Buffer.from(zipSync({ mimetype: [strToU8(`application/vnd.oasis.opendocument.${kind}`), { level: 0 }], "content.xml": strToU8("<office:document-content/>") }));
}
function pptx(): Buffer {
  return Buffer.from(zipSync({ "[Content_Types].xml": strToU8("<Types/>"), "ppt/presentation.xml": strToU8("<p:presentation/>") }));
}

test("1. Fix a PDF: a wrong current password says so, opens the password box, and the right one works", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools/pdf-fix");
  await expect(page.getByRole("heading", { level: 1, name: "Fix a PDF" })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("pdf-fix-input").setInputFiles(join(TOOLS, "sample-a.pdf"));
  await page.locator('input[name="fix-op"][value="encrypt"]').check();
  await page.getByTestId("pdf-fix-pw").fill("river stone 42");
  await page.getByTestId("pdf-fix-pw2").fill("river stone 42");
  await page.getByTestId("pdf-fix-run").click();
  const locked = await download(page, () => page.getByTestId("pdf-fix-download").click());

  await page.goto("/app/tools/pdf-fix");
  await page.getByTestId("pdf-fix-input").setInputFiles({ name: "locked.pdf", mimeType: "application/pdf", buffer: locked.bytes });
  await page.getByTestId("pdf-fix-run").click();
  await expect(page.getByTestId("pdf-fix-error")).toHaveText("This PDF is locked. Type its current password and try again.");
  await expect(page.getByTestId("pdf-fix-current")).toBeVisible();
  await expect(page.getByTestId("pdf-fix-current")).toBeFocused();
  await page.getByTestId("pdf-fix-current").fill("wrong guess");
  await page.getByTestId("pdf-fix-run").click();
  await expect(page.getByTestId("pdf-fix-error")).toHaveText("That password is not right. Check it and try again.");
  await expect(page.getByTestId("pdf-fix-error")).not.toContainText("damaged");
  await expect(page.getByTestId("pdf-fix-current")).toBeFocused();
  await expect(page.getByTestId("pdf-fix-current")).toHaveAttribute("aria-invalid", "true");
  await noSeriousAxe(page);
  await shots(page, "pdf-wrong-password");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/tools/pdf-fix");
  await page.getByTestId("pdf-fix-input").setInputFiles({ name: "locked.pdf", mimeType: "application/pdf", buffer: locked.bytes });
  await page.locator("summary", { hasText: "already has a password" }).click();
  await page.getByTestId("pdf-fix-current").fill("river stone 42");
  await page.getByTestId("pdf-fix-run").click();
  const fixed = await download(page, () => page.getByTestId("pdf-fix-download").click());
  expect(fixed.bytes.subarray(0, 5).toString()).toBe("%PDF-");
});

test("2. Slides and drawings: ODG to PDF and PowerPoint to ODP in the Convert hub; the card is on the Tools hub", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools");
  await expect(page.getByText("Slides and drawings").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Image links").first()).toBeVisible();
  await noSeriousAxe(page);
  await page.goto("/app/tools/convert");
  await expect(page.getByTestId("convert-drop")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("convert-input").setInputFiles({ name: "plan.odg", mimeType: "application/vnd.oasis.opendocument.graphics", buffer: odf("graphics") });
  await expect(page.getByTestId("convert-file")).toHaveCount(1);
  await expect(page.getByTestId("convert-to-svg")).toBeVisible();
  await page.getByTestId("convert-to-pdf").click();
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(1, { timeout: 60_000 });
  const pdf = await download(page, () => page.getByTestId("convert-download").first().click());
  expect(pdf.name).toBe("plan.pdf");
  expect(pdf.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  await shots(page, "convert-odg", ["1280"]);
  await page.getByTestId("convert-clear-files").click();
  await page.getByTestId("convert-clear-tray").click();
  await page.getByTestId("convert-input").setInputFiles({ name: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: pptx() });
  await page.getByTestId("convert-to-odp").click();
  await page.getByTestId("convert-run").click();
  await expect(page.locator('[data-testid="convert-job"][data-status="done"]')).toHaveCount(1, { timeout: 60_000 });
  const odp = await download(page, () => page.getByTestId("convert-download").first().click());
  expect(odp.name).toBe("deck.odp");
  await noSeriousAxe(page);
});

test("3. Link preview: a card with copy buttons; private addresses and bad links are refused", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.goto("/app/tools/utilities");
  await page.getByTestId("utility-link-preview").click();
  await expect(page.getByRole("heading", { level: 1, name: "Link preview" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("link-preview-empty")).toBeVisible();
  await noSeriousAxe(page);
  await shots(page, "link-preview-empty");
  await page.setViewportSize({ width: 1280, height: 900 });
  // The server's own guard, no network needed: loopback and metadata addresses never leave the box.
  for (const bad of ["http://127.0.0.1/admin", "http://169.254.169.254/latest"]) {
    await page.getByTestId("link-preview-url").fill(bad);
    await page.getByTestId("link-preview-run").click();
    await expect(page.getByTestId("util-error")).toHaveText("Links to private networks can't be previewed.");
  }
  const direct = await page.request.post("/api/tools-c2/link-preview", { data: { url: "http://localhost:8080/" } });
  expect(direct.status()).toBe(422);
  await noSeriousAxe(page);
  await shots(page, "link-preview-error", ["1280"]);
  // A real site is mocked in the browser so CI never depends on the internet.
  await page.route("**/api/tools-c2/link-preview", (r) => r.fulfill({ json: { url: "https://example.org/post", finalUrl: "https://example.org/post", title: "How we plan a calm week", description: "Three habits that keep the inbox small and the calendar honest.", siteName: "Example Journal", image: null, imageUrl: null, favicon: null } }));
  await page.getByTestId("link-preview-url").fill("example.org/post");
  await page.getByTestId("link-preview-url").press("Enter");
  await expect(page.getByTestId("link-preview-title")).toHaveText("How we plan a calm week");
  await expect(page.getByTestId("link-preview-open")).toHaveAttribute("href", "https://example.org/post");
  await expect(page.getByTestId("link-preview-open")).toHaveAttribute("rel", /noopener/);
  await page.getByRole("button", { name: "Copy as Markdown" }).click();
  await expect(page.getByText("Copied").first()).toBeVisible();
  await noSeriousAxe(page);
  await shots(page, "link-preview-card");
});

async function mailPicture(page: Page, context: BrowserContext): Promise<string> {
  const base = test.info().project.use.baseURL!;
  if (/localhost|127\.0\.0\.1/.test(base)) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.128.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const boxes = (await (await page.request.get("/api/mailboxes")).json()).mailboxes as { id: string; address: string; status: string }[];
  const key = (await (await page.request.post("/api/inbound-keys", { headers })).json()).key as { id: string; secret: string };
  const tag = Math.random().toString(36).slice(2, 6);
  const png = readFileSync(join(CONV, "photo-a.png")).toString("base64").replace(/.{76}/g, "$&\r\n");
  for (const b of boxes.filter((x) => x.status === "active")) {
    const raw = [
      "From: Pat Lee <pat.lee@example.org>", `To: ${b.address}`, `Subject: Team photo ${tag}`,
      `Message-ID: <photo.${tag}.${b.id}@example.org>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "",
      "Here is the team photo.", "", "--b1", 'Content-Type: image/png; name="team.png"',
      'Content-Disposition: attachment; filename="team.png"', "Content-Transfer-Encoding: base64", "", png, "--b1--", "",
    ].join("\r\n");
    const body = new TextEncoder().encode(raw);
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(key.secret, ts, "pat.lee@example.org", b.address, body.buffer as ArrayBuffer);
    const posted = await page.request.post("/api/inbound/cloudflare", {
      headers: { "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": "pat.lee@example.org", "x-mymail-envelope-to": b.address, "x-mymail-signature": signature },
      data: Buffer.from(body),
    });
    if ((await posted.json()).action !== "accept") continue;
    for (const folder of ["inbox", "spam"]) {
      const list = (await (await page.request.get(`/api/mail/messages?mailboxId=${b.id}&folder=${folder}`)).json()).messages as { id: string; subject: string; threadId: string }[];
      const m = list.find((x) => x.subject === `Team photo ${tag}`);
      if (m) return m.threadId;
    }
  }
  throw new Error("no mailbox took the picture");
}

test("4. Image links: from a mail picture to a resized link; bad sizes explained; other workspaces get 404", async ({ page, context, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const threadId = await mailPicture(page, context);
  await page.goto(`/app/inbox?thread=${encodeURIComponent(threadId)}`);
  await expect(page.getByText("Here is the team photo").first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("attachment-tools").first().click();
  await page.getByRole("menuitem", { name: /^Image link$/ }).click();
  await expect(page).toHaveURL(/\/app\/tools\/image-links\?attachment=/, { timeout: 15_000 });
  const attachmentId = new URL(page.url()).searchParams.get("attachment")!;
  await expect(page.getByTestId("image-preview")).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => page.getByTestId("image-preview").evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.getByTestId("image-preset-thumb").click();
  await expect(page.getByTestId("image-link")).toHaveText(`/api/img/file/${attachmentId}?w=320&h=320&fit=cover&crop=smart&fmt=webp`);
  await expect(page.getByTestId("image-crop")).toBeVisible();
  await expect.poll(async () => page.getByTestId("image-preview").evaluate((i: HTMLImageElement) => i.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  await noSeriousAxe(page);
  await shots(page, "image-links");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId("image-h").fill("");
  await expect(page.getByTestId("image-needs-both")).toBeVisible();
  const bad = await page.request.get(`/api/img/file/${attachmentId}?w=99999`);
  expect(bad.status()).toBe(422);
  expect((await bad.json()).error.message).toMatch(/between 0 and 4096/);
  const ok = await page.request.get(`/api/img/file/${attachmentId}?w=64`);
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toMatch(/^image\//);
  expect(ok.headers()["content-security-policy"]).toContain("default-src 'none'");
  // Someone in another workspace cannot read it, cached or not.
  const other = await browser.newContext();
  const op = await other.newPage();
  await signIn(op, "Otto");
  expect((await op.request.get(`/api/img/file/${attachmentId}?w=64`)).status()).toBe(404);
  expect((await op.request.get(`/api/img/doc/${attachmentId}`)).status()).toBe(404);
  await other.close();
  // The page with no picture explains where to start, and a foreign address is refused.
  await page.goto("/app/tools/image-links");
  await expect(page.getByTestId("image-links-empty")).toBeVisible();
  await page.getByTestId("image-links-paste").fill("https://elsewhere.example/cat.png");
  await page.getByTestId("image-links-use").click();
  await expect(page.getByTestId("image-links-paste-error")).toBeVisible();
  await noSeriousAxe(page);
  await shots(page, "image-links-empty");
});

test("5. Forest theme on Link preview, Image links and the Tools hub, at 1280 and 390", async ({ page }) => {
  test.skip(!SHOTS, "screenshots only with SHOTS_DIR");
  await signIn(page);
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  mkdirSync(SHOTS!, { recursive: true });
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, path] of [["link-preview", "/app/tools/utilities/link-preview"], ["image-links", "/app/tools/image-links"], ["hub", "/app/tools"], ["pdf-fix", "/app/tools/pdf-fix"]] as const) {
      await page.goto(path);
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(SHOTS!, `r100b-${name}-${vp}-forest.png`), fullPage: true });
    }
    await noSeriousAxe(page);
  }
});
