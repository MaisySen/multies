import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sign } from "../email-worker/src/index";

/**
 * Tools P1: run a tool straight from a mail attachment. A PDF arrives through the signed inbound webhook,
 * the attachment's Tools menu opens the Tools page with it already chosen, and the result downloads.
 * Local only (it uses a demo workspace): TOOLS_E2E=1 E2E_BASE_URL=http://localhost:PORT with Tools on.
 */
const FIX = "e2e/fixtures/tools";
const SHOTS = process.env.TOOLS_SHOTS;
test.skip(process.env.TOOLS_E2E !== "1", "needs a server with Tools on and a document engine");

test("compress a PDF attachment from the message, with no upload", async ({ page, context }) => {
  test.setTimeout(120_000);
  const base = test.info().project.use.baseURL!;
  // Local demo sign ins are rate limited per address; each run comes from its own test address.
  if (/localhost|127\.0\.0\.1/.test(base)) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.127.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  const headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const boxes = (await (await page.request.get("/api/mailboxes")).json()).mailboxes as { id: string; address: string; status: string }[];
  const key = (await (await page.request.post("/api/inbound-keys", { headers })).json()).key as { id: string; secret: string };
  const tag = Math.random().toString(36).slice(2, 6);
  const pdf = readFileSync(join(FIX, "sample-a.pdf")).toString("base64").replace(/.{76}/g, "$&\r\n");
  // The first of the workspace's own mailboxes that takes inbound mail (connected ones do not).
  let box: { id: string; address: string } | undefined;
  for (const b of boxes.filter((x) => x.status === "active")) {
    const raw = [
      "From: Pat Lee <pat.lee@example.org>", `To: ${b.address}`, `Subject: Signed contract ${tag}`,
      `Message-ID: <contract.${tag}.${b.id}@example.org>`, `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"', "", "--b1", "Content-Type: text/plain; charset=utf-8", "",
      "Hi, the signed contract is attached.", "", "--b1", 'Content-Type: application/pdf; name="sample-a.pdf"',
      'Content-Disposition: attachment; filename="sample-a.pdf"', "Content-Transfer-Encoding: base64", "", pdf, "--b1--", "",
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
  expect(box, "a mailbox that takes inbound mail").toBeTruthy();
  // Unsigned outside mail can land in Spam; look in both.
  let msg: { id: string; subject: string; threadId: string } | undefined;
  for (const folder of ["inbox", "spam"]) {
    const list = (await (await page.request.get(`/api/mail/messages?mailboxId=${box!.id}&folder=${folder}`)).json()).messages as { id: string; subject: string; threadId: string }[];
    msg ??= list.find((m) => m.subject === `Signed contract ${tag}`);
  }
  expect(msg, "the delivered message").toBeTruthy();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/inbox?thread=${encodeURIComponent(msg!.threadId)}`);
  await expect(page.getByText("the signed contract is attached").first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("attachment-tools").first().click();
  await expect(page.getByRole("menuitem", { name: "Compress PDF" })).toBeVisible();
  await page.waitForTimeout(400); // let the menu finish opening for the screenshot
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, "tools-attachment-menu-desktop-light.png") }); }
  await page.getByRole("menuitem", { name: "Compress PDF" }).click();
  await expect(page.getByTestId("tools-from-mail")).toContainText("sample-a.pdf");
  await expect(page.getByTestId("tools-run")).toBeEnabled();
  await page.getByTestId("tools-run").click();
  await expect(page.getByTestId("tools-download")).toBeVisible({ timeout: 60_000 });
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "tools-attachment-done-desktop-light.png") });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("tools-download").click()]);
  const out = readFileSync((await dl.path())!);
  expect(out.subarray(0, 5).toString()).toBe("%PDF-");
  expect(out.byteLength).toBeLessThan(readFileSync(join(FIX, "sample-a.pdf")).byteLength);
  expect(dl.suggestedFilename()).toBe("sample-a-compressed.pdf");
});
