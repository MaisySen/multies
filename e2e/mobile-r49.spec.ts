import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";

/**
 * R49 mobile web: Docs, Meetings and Chat at 360, 390 and 430 px, light and dark. The open doc keeps its
 * formatting toolbar on one row of 44 px buttons with nothing to scroll sideways; the call's controls sit right
 * above the tab bar; the chat composer sits above the tab bar without scrolling the page. SHOTS=round3/before or
 * round3/after writes shots and metrics to /home/user/tab/files/multies-mobile/. The video room is faked through
 * the local test hook (CALLS_TEST_HOOK, refused in production) with the browser's fake camera.
 */
const SHOTS = process.env.SHOTS;
const DIR = "/home/user/tab/files/multies-mobile";
test.use({
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});
let visitor = 0;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.149.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(600_000);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}

type Metrics = {
  overflowX: number; tabBar: boolean; smallTargets: string[]; smallInputs: string[];
  toolbar?: { rows: number; scrolls: boolean; right: number } | null;
  dockGap?: number | null; composerGap?: number | null; bodyPx?: number | null;
};

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("main") as HTMLElement | null;
    const overflowX = Math.max(doc.scrollWidth - window.innerWidth, document.body.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0);
    const bar = document.querySelector("[data-testid=phone-tabbar]") as HTMLElement | null;
    const barRect = bar?.getBoundingClientRect();
    const tabBar = !!barRect && barRect.height > 0 && barRect.bottom <= window.innerHeight + 1;
    const smallTargets: string[] = [];
    for (const el of Array.from(document.querySelectorAll([
      "[data-topbar] a, [data-topbar] button, [data-testid=phone-tabbar] a, [data-testid=phone-tabbar] button",
      "[role=toolbar][aria-label=Formatting] button, [data-testid=doc-bar] a, [data-testid=doc-bar] button, [data-testid=doc-list] a",
      "[data-testid=meeting-row], [data-testid=meeting-actions] button, [data-testid=meeting-page] header button, [data-testid=prejoin] button, [data-testid=prejoin] a, .lk-control-bar button, [data-testid=call-toolbar] button, [data-testid=meeting-connect-failed] button",
      "[data-testid=chat-channel], [data-testid=chat-head] button, [data-testid=chat-head] a, [data-testid=chat-send]",
    ].join(", ")))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) smallTargets.push(`${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const smallInputs: string[] = [];
    for (const el of Array.from(document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]), textarea, select"))) {
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 16) smallInputs.push(`${el.getAttribute("name") ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.tagName} ${fs}px`);
    }
    const tb = document.querySelector("[role=toolbar][aria-label=Formatting]") as HTMLElement | null;
    let toolbar: Metrics["toolbar"] = null;
    if (tb) {
      const tops = new Set(Array.from(tb.querySelectorAll(":scope > button")).map((b) => Math.round((b as HTMLElement).getBoundingClientRect().top)));
      toolbar = { rows: tops.size, scrolls: tb.scrollWidth > tb.clientWidth + 1, right: Math.round(tb.getBoundingClientRect().right) };
    }
    // The call's controls dock at the foot of the room (the LiveKit control bar, or the reconnect card when the
    // local stub room cannot connect), so the room's bottom edge is where they sit.
    const room = (document.querySelector(".lk-control-bar") ?? document.querySelector("[data-testid=meeting-room]")) as HTMLElement | null;
    const dockGap = room && barRect ? Math.round(barRect.top - room.getBoundingClientRect().bottom) : null;
    const comp = document.querySelector("[data-testid=chat-composer]") as HTMLElement | null;
    const composerGap = comp && barRect ? Math.round(barRect.top - comp.getBoundingClientRect().bottom) : null;
    const prose = document.querySelector(".mm-prose") as HTMLElement | null;
    const bodyPx = prose ? parseFloat(getComputedStyle(prose).fontSize) : null;
    return { overflowX, tabBar, smallTargets, smallInputs, toolbar, dockGap, composerGap, bodyPx };
  });
}

/** The local server has no video keys: show meetings as video on and hand the room a stub token (browser side only). */
async function fakeVideo(page: Page) {
  await page.route(/\/api\/meetings\/[^/?]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch(); const body = await res.json().catch(() => null);
    if (!body?.meeting) return route.fulfill({ response: res });
    body.meeting.videoEnabled = true;
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/meetings\/([^/?]+)\/join$/, (route) => {
    const id = /\/api\/meetings\/([^/?]+)\/join$/.exec(route.request().url())![1];
    return route.fulfill({ json: { url: "wss://127.0.0.1:9", token: "stub", room: "stub", meeting: { id } } });
  });
}

let meetingId = "";
let docId = "";
async function setup(page: Page) {
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  if (!docId) {
    const d = await (await page.request.get("/api/docs")).json();
    docId = d.docs?.[0]?.id ?? "";
  }
  if (!meetingId) {
    const r = await page.request.post("/api/meetings", { data: { title: "Weekly design review" }, headers });
    meetingId = (await r.json()).meeting.id;
    await page.request.post(`/api/chat/calls/${meetingId}/test-room`, { data: { participants: [{ name: "Sam Mate" }, { name: "Gail Guest" }] }, headers });
  }
  await fakeVideo(page);
}

const SCREENS: { name: string; go: (page: Page) => Promise<void> }[] = [
  { name: "docs", go: async (p) => { await p.goto("/app/docs"); await expect(p.getByTestId("doc-list")).toBeVisible({ timeout: 20_000 }); await p.waitForTimeout(400); } },
  { name: "doc-open", go: async (p) => { await p.goto("/app/docs"); await p.getByTestId("doc-list").locator("a").first().click(); await expect(p.getByLabel("Doc title")).toBeVisible({ timeout: 20_000 }); await p.getByRole("toolbar", { name: "Formatting" }).waitFor({ timeout: 8_000 }).catch(() => {}); await p.waitForTimeout(600); } },
  { name: "meetings", go: async (p) => { await p.goto("/app/meetings"); await p.waitForTimeout(1200); } },
  { name: "meeting", go: async (p) => { await p.goto(`/app/meetings/${meetingId}`); await expect(p.getByTestId("join-meeting")).toBeVisible({ timeout: 20_000 }); await p.waitForTimeout(400); } },
  { name: "meeting-prejoin", go: async (p) => { await p.goto(`/app/meetings/${meetingId}`); await p.getByTestId("join-meeting").click(); await expect(p.getByTestId("prejoin")).toBeVisible(); await p.waitForTimeout(1200); } },
  { name: "meeting-call", go: async (p) => { await p.goto(`/app/meetings/${meetingId}`); await p.getByTestId("join-meeting").click(); await p.getByTestId("prejoin-join").click(); await expect(p.getByTestId("meeting-room")).toBeVisible(); await p.waitForTimeout(1500); } },
  { name: "chat", go: async (p) => { await p.goto("/app/chat?list=1"); await expect(p.getByRole("navigation", { name: "Channels" })).toBeVisible({ timeout: 15_000 }); await p.waitForTimeout(800); } },
  { name: "chat-channel", go: async (p) => { await p.goto("/app/chat?list=1"); await p.getByRole("navigation", { name: "Channels" }).locator("a[href^='/app/chat/']").first().click(); await expect(p.getByTestId("chat-composer")).toBeAttached({ timeout: 15_000 }); await p.waitForTimeout(1000); } },
];

for (const scheme of ["light", "dark"] as const) {
  test(`R49 docs, meetings and chat audit (${scheme})`, async ({ page }) => {
    const widths = SHOTS ? [360, 390, 430] : [360, 390];
    page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(20_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    meetingId = ""; docId = ""; // each test opens its own demo workspace
    await setup(page);
    const report: Record<string, Metrics | { error: string }> = {};
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: 844 });
      for (const s of SCREENS) {
        const key = `${s.name}-${w}`;
        try {
          await s.go(page);
          await page.waitForTimeout(300);
          report[key] = await measure(page);
          if (SHOTS) { fs.mkdirSync(`${DIR}/${SHOTS}`, { recursive: true }); await page.screenshot({ path: `${DIR}/${SHOTS}/${s.name}-${w}-${scheme}.png`, type: "png" }); }
        } catch (e) { report[key] = { error: String(e).slice(0, 300) }; }
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
    if (SHOTS) { fs.writeFileSync(`${DIR}/${SHOTS}/metrics-${scheme}.json`, JSON.stringify(report, null, 1)); return; }
    for (const [key, m] of Object.entries(report)) {
      expect.soft("error" in m ? m.error : "", `${key} loads`).toBe("");
      if ("error" in m) continue;
      expect.soft(m.overflowX, `${key}: no sideways scroll`).toBeLessThanOrEqual(0);
      expect.soft(m.tabBar, `${key}: tab bar on screen`).toBe(true);
      expect.soft(m.smallTargets, `${key}: 44 px targets`).toEqual([]);
      expect.soft(m.smallInputs, `${key}: 16 px fields`).toEqual([]);
      if (key.startsWith("doc-open")) {
        expect.soft(m.toolbar?.rows, `${key}: toolbar is one row`).toBe(1);
        expect.soft(m.toolbar?.scrolls, `${key}: toolbar does not scroll sideways`).toBe(false);
        expect.soft(m.bodyPx ?? 0, `${key}: body text at least 17 px`).toBeGreaterThanOrEqual(17);
      }
      if (key.startsWith("meeting-call")) { expect.soft(m.dockGap ?? -999, `${key}: call controls above the tab bar`).toBeGreaterThanOrEqual(-1); expect.soft(m.dockGap ?? 999, `${key}: call controls dock on the tab bar`).toBeLessThanOrEqual(24); }
      if (key.startsWith("chat-channel")) { expect.soft(m.composerGap ?? -999, `${key}: composer above the tab bar`).toBeGreaterThanOrEqual(0); expect.soft(m.composerGap ?? 999, `${key}: composer sits on the tab bar`).toBeLessThanOrEqual(48); }
    }
  });
}
