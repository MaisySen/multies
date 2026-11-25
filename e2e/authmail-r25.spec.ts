import { test, expect } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R25 (MB-60, found by Haajir): branded auth emails. A workspace key brands a Supabase auth email hook
 * over the public API (logo, colour, reply-to, footer, per type text, Nepali under English), the preview
 * returns the email without sending it, and the rendered HTML is what a parent would see. There is no
 * screen for hooks in the app, so the screenshot is the previewed email itself.
 */
const SECRET = `v1,whsec_${Buffer.from("supabase-hook-secret-0123456789").toString("base64")}`;
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="168" height="40" viewBox="0 0 168 40"><rect width="40" height="40" rx="10" fill="#0F7B6C"/><path d="M12 11v18M28 11v18M12 20h16" stroke="#fff" stroke-width="4" stroke-linecap="round"/><text x="50" y="28" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="22" font-weight="700" fill="#1d1d1f">Haajir</text></svg>`;

test("a workspace key brands the auth emails and previews them in English and Nepali", async ({ page, baseURL }) => {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.95.${test.info().workerIndex % 200}.1` });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  const session = await page.evaluate(async () => {
    const post = (path: string, body: unknown) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    const key = await post("/api/developer/keys", { name: "Haajir HQ" });
    const ro = await post("/api/developer/keys", { name: "Reader", scope: "read" });
    const boxes = await fetch("/api/mailboxes").then((r) => r.json());
    // W4: a team mailbox. The demo's first mailbox is now Alex's personal sample (connected mail), and since PRIV1b (W1) and
    // AIS1 (row 44) only a team mailbox on a verified domain may send sign-up emails.
    const team = ((boxes.mailboxes ?? boxes) as { address: string; personal?: boolean; kind?: string }[]).find((m) => !m.personal && m.kind !== "agent")!;
    return { key: key.secret as string, ro: ro.secret as string, from: team.address };
  });
  expect(session.key).toMatch(/^mm_live_/);
  const api = (k: string) => ({ authorization: `Bearer ${k}`, "content-type": "application/json" });

  const made = await page.request.post(`${baseURL}/api/v1/auth-email-hooks`, { headers: api(session.key), data: { from: session.from, secret: SECRET, supabaseUrl: "https://abcd1234.supabase.co", appName: "Haajir" } });
  expect(made.status()).toBe(201);
  const hook = (await made.json()).hook;
  expect(hook.branding).toBeNull();

  const patched = await page.request.patch(`${baseURL}/api/v1/auth-email-hooks/${hook.id}`, { headers: api(session.key), data: { branding: {
    logoUrl: "https://haajir.example/logo.png", brandColor: "#0F7B6C", replyTo: "support@haajir.example",
    footer: "Haajir, attendance for Nepali schools. Reply to this email with any question.",
    templates: { signup: { subject: "Welcome to {appName}", intro: "Hi {email},\n\nconfirm your email to start following your child's attendance in {appName}.", buttonLabel: "Confirm my email" } },
    secondaryLanguage: { lang: "ne", templates: { signup: { subject: "हाजिरमा स्वागत छ", intro: "नमस्ते {email}, आफ्नो बच्चाको हाजिरी हेर्न {appName} मा आफ्नो इमेल पुष्टि गर्नुहोस्।", buttonLabel: "इमेल पुष्टि गर्नुहोस्" } }, note: "तपाईंले यो अनुरोध गर्नुभएको होइन भने यो इमेल बेवास्ता गर्नुहोस्।" },
  } } });
  expect(patched.status()).toBe(200);
  expect((await patched.json()).hook.branding.replyTo).toBe("support@haajir.example");

  // A read only key can preview but not change it.
  expect((await page.request.patch(`${baseURL}/api/v1/auth-email-hooks/${hook.id}`, { headers: api(session.ro), data: { branding: null } })).status()).toBe(403);
  const pv = await page.request.post(`${baseURL}/api/v1/auth-email-hooks/${hook.id}/preview?type=signup`, { headers: api(session.ro), data: { email: "sita.sharma@example.com" } });
  expect(pv.status()).toBe(200);
  const preview = (await pv.json()).preview;
  expect(preview.subject).toBe("Welcome to Haajir / हाजिरमा स्वागत छ");
  expect(preview.replyTo).toBe("support@haajir.example");
  expect(preview.text).toContain("123456");

  // Render the email the way a mail app shows it.
  await page.route("https://haajir.example/logo.png", (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: LOGO }));
  await page.setViewportSize({ width: 720, height: 980 });
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}.mail{max-width:600px;margin:32px auto;background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);overflow:hidden}.head{padding:18px 24px;border-bottom:1px solid #e5e5ea;font-size:13px;color:#6e6e73;line-height:1.6}.head b{color:#1d1d1f;font-weight:600}.subj{font-size:17px;color:#1d1d1f;font-weight:600;margin-bottom:6px}.body{padding:24px}</style></head><body><div class="mail"><div class="head"><div class="subj">${esc(preview.subject)}</div><div><b>From</b> Haajir &lt;${esc(session.from)}&gt;</div><div><b>To</b> ${esc(preview.to)}</div><div><b>Reply-To</b> ${esc(preview.replyTo)}</div></div><div class="body">${preview.html}</div></div></body></html>`);
  await expect(page.getByRole("link", { name: "Confirm my email" })).toBeVisible();
  await expect(page.getByRole("link", { name: "इमेल पुष्टि गर्नुहोस्" })).toBeVisible();
  await expect(page.locator('[lang="ne"]')).toContainText("नमस्ते sita.sharma@example.com");
  expect(await page.locator("img").evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r25/r25-authmail.png`, fullPage: true });
});
