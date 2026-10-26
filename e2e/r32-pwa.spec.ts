import { test, expect, type Page } from "@playwright/test";

/**
 * R32: offline app shell and browser notifications.
 * Needs a production build (npm run build:web): the service worker registers only in production builds, and
 * automated browsers only when localStorage "mymail-sw" is "1".
 */
const SHOTS = process.env.R32_SHOTS_DIR ?? "test-results";

async function signUp(page: Page, name: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(`pwa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
}

test("the app opens offline after one online visit, with a quiet offline strip", async ({ page, context, request }) => {
  test.setTimeout(90_000);
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["cache-control"]).toBe("no-cache");

  await page.addInitScript(() => localStorage.setItem("mymail-sw", "1"));
  await signUp(page, "Paula Offline");
  // R33: one overdue task of hers, so My Work has a row to keep for offline.
  const me = await (await page.request.get("/api/account/me")).json() as { user: { id: string } };
  const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string }[];
  const due = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const made = await page.request.post("/api/tasks", { data: { projectId: projects[0].id, title: "Send the offline report", assignee: `member:${me.user.id}`, due } });
  expect(made.ok()).toBe(true);
  await page.goto("/app/my-work");
  await expect(page.getByText("Send the offline report")).toBeVisible({ timeout: 15_000 });
  // The worker installs after load and claims this page; the shell is precached by then.
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 30_000 });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  const cached = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith("multies-")));
  expect(cached.length).toBeGreaterThan(0);

  await context.setOffline(true);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 15_000 });
  // The page itself comes from the stored chunks: the frame, the greeting (account from the offline copy).
  await expect(page.getByRole("heading", { name: /Good (morning|afternoon|evening), Paula/ })).toBeVisible({ timeout: 15_000 });
  // R33: My Work shows its last stored copy (not the empty or error state) and says from when.
  await expect(page.getByText("Send the offline report")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("offline-copy-at")).toContainText(/Offline\. Showing your last copy from \d{1,2}:\d{2}/);
  await page.reload();
  await expect(page.getByText("Send the offline report")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/pwa-offline.png` });

  // An /app page this browser never opened still opens from the same shell.
  await page.goto("/app/tasks");
  await expect(page.getByTestId("offline-banner")).toBeVisible({ timeout: 15_000 });

  await context.setOffline(false);
  await page.goto("/app/my-work");
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);

  // Sign out (account menu) leaves no Multies cache behind for the next person on this browser.
  await page.getByRole("button", { name: /Paula Offline/ }).first().click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  // The sign in page refills public files (assets, config, sign in methods) at once; nothing of the person stays.
  const left = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const k of (await caches.keys()).filter((n) => n.startsWith("multies-"))) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
    return urls;
  });
  expect(left).not.toContain("/api/account/me");
  expect(left).not.toContain("/app");
  expect(left.filter((u) => u.startsWith("/api/") && !["/api/config", "/api/account/providers"].includes(u))).toEqual([]);
  // R33: the stored list copies are gone too.
  const kept = await page.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open("multies-offline", 1);
    req.onupgradeneeded = () => { req.result.createObjectStore("lists", { keyPath: "key" }); };
    req.onsuccess = () => { const c = req.result.transaction("lists", "readonly").objectStore("lists").count(); c.onsuccess = () => { resolve(c.result); req.result.close(); }; };
    req.onerror = () => resolve(-1);
  }));
  expect(kept).toBe(0);
});

test("browser notifications: ask, subscribe and save this browser from Settings", async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["notifications"]);
  // Headless Chromium has no notification or push service (it reports "denied" whatever is granted), so the
  // permission prompt and the subscription are stand-ins; the subscription carries real P-256 keys.
  await page.addInitScript(() => {
    let permission: NotificationPermission = "default";
    Object.defineProperty(Notification, "permission", { get: () => permission });
    Notification.requestPermission = async () => { permission = "granted"; return permission; };
    let current: PushSubscription | null = null;
    const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    PushManager.prototype.getSubscription = async () => current;
    PushManager.prototype.subscribe = async () => {
      const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
      const p256dh = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
      const auth = b64(crypto.getRandomValues(new Uint8Array(16)).buffer);
      const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${Date.now()}`;
      current = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh, auth } }), unsubscribe: async () => { current = null; return true; } } as unknown as PushSubscription;
      return current;
    };
  });
  await signUp(page, "Nora Notify");
  await page.goto("/app/settings/notifications");
  const card = page.getByTestId("browser-notifications");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText("Browser notifications", { exact: true })).toBeVisible();
  const toggle = card.getByRole("switch", { name: "Browser notifications" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const saved = await page.evaluate(async () => (await (await fetch("/api/push/web", { credentials: "same-origin" })).json()) as { enabled: boolean; subscriptions: unknown[] });
  expect(saved.enabled).toBe(true);
  expect(saved.subscriptions).toHaveLength(1);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/settings-browser-notifications.png` });

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  const after = await page.evaluate(async () => (await (await fetch("/api/push/web", { credentials: "same-origin" })).json()) as { subscriptions: unknown[] });
  expect(after.subscriptions).toHaveLength(0);
});
