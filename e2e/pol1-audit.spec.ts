import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, appendFileSync } from "node:fs";

/** POL1 design walk (temporary audit, not shipped): every area at 1280 and 390, light and dark, axe, sideways scroll, title, error path timing. */
const DIR = process.env.SHOTS_DIR ?? "/tmp/pol1-audit";
const OUT = process.env.AUDIT_OUT ?? "/tmp/pol1-audit.txt";
mkdirSync(DIR, { recursive: true });
const log = (s: string) => appendFileSync(OUT, s + "\n");
let n = 0;
async function signIn(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `10.151.0.${++n}` });
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return headers;
}
async function check(page: Page, label: string) {
  await page.waitForTimeout(700);
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}@${v.nodes.map((x) => x.target.join(" ")).slice(0, 2).join("|")}`);
  const hs = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  log(`${label} | title=${await page.title()} | hscroll=${hs} | axe=${bad.join(";") || 0}`);
  await page.screenshot({ path: `${DIR}/${label}.png` });
}
test("walk", async ({ page }) => {
  test.setTimeout(900_000);
  const headers = await signIn(page);
  const m = await (await page.request.post("/api/meetings", { data: { title: "Spring product launch", startsAt: new Date(Date.now() + 3600_000).toISOString(), durationMin: 60 }, headers })).json();
  const c = await (await page.request.post("/api/courses", { data: { title: "Workplace safety" }, headers })).json();
  const t = await (await page.request.post("/api/tables", { data: { title: "Jobs board", template: "jobs" }, headers })).json();
  await page.request.post("/api/sites", { data: { name: "Studio", slug: "studio-" + Math.random().toString(36).slice(2, 6) }, headers });
  const pg = await (await page.request.post("/api/sites/pages", { data: { title: "Home" }, headers })).json();
  log(`seed meeting=${!!m.meeting} course=${!!c.course} table=${!!(t.table)} page=${!!pg.page}`);
  const tid = t.table?.id ?? t.table?.docId; const cid = c.course?.id ?? c.course?.docId;
  const pages: [string, string][] = [["home", "/app"], ["meetings", "/app/meetings"], ["meeting", `/app/meetings/${m.meeting.id}`], ["webinar", `/app/meetings/${m.meeting.id}/webinar`], ["vault", "/app/tools/vault"],
    ["learning", "/app/docs/learning"], ["course", `/app/docs/${cid}`], ["table", `/app/docs/${tid}`], ["sites", "/app/docs/sites"], ["siteeditor", `/app/docs/sites/${pg.page?.id}`]];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [k, u] of pages) { await page.goto(u); await check(page, `${k}-${w}-${scheme}`); }
    }
  }
  // kanban at 390
  await page.emulateMedia({ colorScheme: "light" });
  // error path timing: fail each area's api with 500
  const errs: [string, string, RegExp][] = [["home", "/app", /\/api\/home/], ["meetings", "/app/meetings", /\/api\/meetings/], ["vault", "/app/tools/vault", /\/api\/vault/], ["learning", "/app/docs/learning", /\/api\/courses/],
    ["course", `/app/docs/${cid}`, /\/api\/courses/], ["table", `/app/docs/${tid}`, /\/api\/tables/], ["sites", "/app/docs/sites", /\/api\/sites/], ["webinar", `/app/meetings/${m.meeting.id}/webinar`, /\/api\/(webinar|meetings)/]];
  await page.setViewportSize({ width: 1280, height: 860 });
  for (const [k, u, re] of errs) {
    await page.route(re, (r) => r.fulfill({ status: 500, body: JSON.stringify({ error: "boom" }), contentType: "application/json" }));
    const t0 = Date.now();
    await page.goto(u);
    const card = page.getByText("Couldn't load this").first();
    const ok = await card.waitFor({ timeout: 15000 }).then(() => true, () => false);
    log(`ERR ${k} card=${ok} ms=${Date.now() - t0} retry=${await page.getByRole("button", { name: /retry|try again/i }).count()}`);
    await page.screenshot({ path: `${DIR}/err-${k}.png` });
    await page.unroute(re);
  }
});
