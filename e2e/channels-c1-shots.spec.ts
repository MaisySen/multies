import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * C1 chat channel shots: the shared inbox and Settings, desktop 1280 and phone 390, light and dark.
 * SHOT_PHASE=before or after names the files; the after phase also shoots Settings, Channels, chat rows,
 * the chat view with the reply window open and closed (with the template sheet), and the chat view at 360.
 */
const DIR = `${SHOTS_ROOT}/multies-c1`;
const PHASE = process.env.SHOT_PHASE ?? "after";
let visitor = 0;
const ip = () => `10.151.${test.info().workerIndex % 200}.${++visitor}`;

test.skip(!process.env.SHOT_PHASE, "screenshots only when SHOT_PHASE is set");

const shot = (page: Page, area: string, what: string, dev: string, scheme: string) =>
  page.screenshot({ path: `${DIR}/${area}-${PHASE}-${what}-${dev}-${scheme}.png` });

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(700);
}

const DEVICES = [[1280, 860, "desktop"], [390, 844, "phone"]] as const;
const SCHEMES = ["light", "dark"] as const;

test(`C1 shots (${PHASE})`, async ({ browser }) => {
  test.setTimeout(420_000);
  mkdirSync(DIR, { recursive: true });
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 860 }, timezoneId: "UTC", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  let convId = "";
  if (PHASE === "after") {
    // Settings, Channels on a server with no Meta app: the Coming soon card.
    await page.route("**/api/channels/status", (r) => r.fulfill({ json: { available: false, mock: false, enabled: false, canManage: true, channels: [], embeddedSignup: null, usage: { today: 0, softCap: 2000, level: "ok" } } }));
    for (const [w, h, dev] of DEVICES) {
      await page.setViewportSize({ width: w, height: h });
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.goto("/app/settings/channels");
        await expect(page.getByTestId("channels-coming-soon")).toBeVisible();
        await settle(page);
        await shot(page, "settings", "channels-coming-soon", dev, scheme);
      }
    }
    await page.unroute("**/api/channels/status");
    expect((await page.request.put("/api/channels/settings", { data: { enabled: true }, headers })).status()).toBe(200);
    // Settings, Channels with nothing connected yet.
    for (const [w, h, dev] of DEVICES) {
      await page.setViewportSize({ width: w, height: h });
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.goto("/app/settings/channels");
        await expect(page.getByTestId("channels-settings")).toBeVisible();
        await settle(page);
        await shot(page, "settings", "channels-empty", dev, scheme);
      }
    }
    const ch = (await (await page.request.post("/api/channels/connect-mock", { data: { name: "Front desk" }, headers })).json()).channel as { id: string };
    const say = async (from: string, name: string, text: string, image = false) =>
      expect((await page.request.post("/api/channels/mock/inbound", { data: { channelId: ch.id, from, name, text, image }, headers })).status()).toBe(200);
    await say("61400111222", "Priya Shah", "Hi! Is the blue jacket still in stock in medium?");
    await say("61400111222", "Priya Shah", "Here is the one I mean", true);
    await say("61400333444", "Marco Rossi", "Can I change my delivery address for order 1042?");
    await say("61400555666", "Lena Park", "Thanks, the parcel arrived today.");
    const list = (await (await page.request.get("/api/channels/conversations", { headers })).json()).data as { id: string; contactName: string }[];
    convId = list.find((c) => c.contactName === "Priya Shah")!.id;
    await page.request.post(`/api/channels/conversations/${convId}/messages`, { data: { text: "Hi Priya, yes we have it in medium. Want me to hold one for you?" }, headers: { ...headers, "Idempotency-Key": `shot-${Date.now()}` } });
    for (const [w, h, dev] of DEVICES) {
      await page.setViewportSize({ width: w, height: h });
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.goto("/app/settings/channels");
        await expect(page.getByTestId("channel-row").first()).toBeVisible();
        await settle(page);
        await shot(page, "settings", "channels-connected", dev, scheme);
      }
    }
  }

  for (const [w, h, dev] of DEVICES) {
    await page.setViewportSize({ width: w, height: h });
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto("/app/inbox");
      await expect(page.getByRole("heading", { name: "Shared inbox" })).toBeVisible();
      await settle(page);
      await shot(page, "inbox", "list", dev, scheme);
      await page.goto(dev === "desktop" ? "/app/settings/team" : "/app/settings");
      await settle(page);
      await shot(page, "settings", dev === "desktop" ? "team" : "hub", dev, scheme);
      if (PHASE === "after") {
        await page.goto(`/app/inbox?conv=${convId}`);
        await expect(page.getByTestId("chat-view")).toBeVisible();
        await settle(page);
        await shot(page, "inbox", "chat-open", dev, scheme);
      }
    }
  }

  if (PHASE === "after") {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`/app/inbox?conv=${convId}`);
    await expect(page.getByTestId("chat-view")).toBeVisible();
    await settle(page);
    await shot(page, "inbox", "chat-open", "phone360", "light");
    // Close the reply window, then the template sheet.
    expect((await page.request.post("/api/channels/mock/age", { data: { conversationId: convId, hours: 25 }, headers })).status()).toBe(200);
    for (const [w, h, dev] of DEVICES) {
      await page.setViewportSize({ width: w, height: h });
      for (const scheme of SCHEMES) {
        await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
        await page.goto(`/app/inbox?conv=${convId}`);
        await expect(page.getByTestId("window-closed")).toBeVisible();
        await settle(page);
        await shot(page, "inbox", "chat-closed", dev, scheme);
        await page.getByRole("button", { name: "Choose a template" }).click();
        await expect(page.getByTestId("template-option").first()).toBeVisible();
        await settle(page);
        await shot(page, "inbox", "template-sheet", dev, scheme);
      }
    }
    await page.setViewportSize({ width: 360, height: 780 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`/app/inbox?conv=${convId}`);
    await expect(page.getByTestId("window-closed")).toBeVisible();
    await settle(page);
    await shot(page, "inbox", "chat-closed", "phone360", "light");
  }
  await ctx.close();
});
