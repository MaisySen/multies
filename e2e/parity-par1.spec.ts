import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/**
 * PAR1 phone parity. For each main page, list the actions a desktop user sees at 1280, then list every action a phone
 * user can reach at 390 (touch, no hover): what is visible, the options of visible pickers, and what opens from each
 * menu, sheet or overflow button on the page. An action seen on desktop that a phone user cannot reach is a gap.
 * Controls hidden by opacity until hover count as not reachable on a phone. PAR1_AUDIT=1 only lists (PAR1_OUT JSON);
 * otherwise any gap outside the reviewed list fails. SHOTS_DIR writes one shot per page and width.
 */
const AUDIT = process.env.PAR1_AUDIT === "1";
const OUT = process.env.PAR1_OUT ?? "/tmp/par1-parity.json";
const SHOTS = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;

/** Desktop only on purpose: keyboard hints, resize handles and hover previews have no phone meaning. */
const DESKTOP_ONLY = [/^resize/, /^drag /, /keyboard shortcuts?$/, /^collapse sidebar$/, /^expand sidebar$/];

async function names(page: Page, scope: string, opts: { touch: boolean }) {
  return page.evaluate(({ scope, touch }) => {
    const out = new Set<string>();
    const shown = (el: Element) => {
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) return false;
      for (let p: Element | null = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
        if (touch && s.pointerEvents === "none" && p === el) return false;
      }
      return !el.closest("[aria-hidden=true],[inert]") && !el.closest(".sr-only");
    };
    const norm = (t: string) => t.toLowerCase().replace(/[0-9,.:]+/g, " ").replace(/\s+/g, " ").trim();
    const roots = Array.from(document.querySelectorAll(scope));
    const nodes = roots.flatMap((r) => Array.from(r.querySelectorAll("button, a[href], [role=button], [role=tab], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], select, [role=switch]")));
    for (const el of nodes) {
      if (!shown(el)) continue;
      if (el.tagName === "SELECT") { for (const o of Array.from((el as HTMLSelectElement).options)) out.add(norm(o.text)); const l = el.getAttribute("aria-label"); if (l) out.add(norm(l)); continue; }
      const t = el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || "";
      const n = norm(t.split("\n")[0]);
      if (n.length > 1) out.add(n);
      const title = el.getAttribute("title"); if (title) out.add(norm(title));
    }
    return Array.from(out);
  }, { scope, touch: opts.touch });
}

async function phoneReach(page: Page) {
  const reach = new Set(await names(page, "body", { touch: true }));
  const triggers = page.locator("main button[aria-haspopup]:visible, main button[aria-expanded=false]:visible, header button[aria-haspopup]:visible, main summary:visible, main button:visible").filter({ hasNotText: /^(delete|remove|send|sign out|discard)/i });
  const n = Math.min(await triggers.count(), 40);
  const url = page.url();
  for (let i = 0; i < n; i++) {
    const t = triggers.nth(i);
    const label = ((await t.getAttribute("aria-label")) ?? (await t.innerText().catch(() => ""))).toLowerCase();
    const popup = (await t.getAttribute("aria-haspopup")) || (await t.getAttribute("aria-expanded")) || /more|option|action|menu|filter|view|sort|sheet|tools|details|panel|info|comments|history/.test(label);
    if (!popup) continue;
    if (/delete|remove|sign out|discard|leave|archive all/.test(label)) continue;
    await t.click({ timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(350);
    for (const x of await names(page, "body", { touch: true })) reach.add(x);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(150);
    if (page.url() !== url) { await page.goto(url); await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {}); }
  }
  return reach;
}

let ctx: BrowserContext, phone: BrowserContext;
let pages: [string, string][] = [];
const report: { page: string; desktop: string[]; missing: string[]; why?: Record<string, string> }[] = [];

/** For a gap: how the phone page holds the control with that name (absent, hidden, see through, disabled). */
async function whyMissing(page: Page, missing: string[]) {
  return page.evaluate((missing) => {
    const norm = (t: string) => t.toLowerCase().replace(/[0-9,.:]+/g, " ").replace(/\s+/g, " ").trim();
    const out: Record<string, string> = {};
    const all = Array.from(document.querySelectorAll("button, a[href], [role=button], [role=tab], [role=menuitem], [role=option], select, [role=switch], option"));
    for (const m of missing) {
      const el = all.find((e) => norm((e.getAttribute("aria-label") || (e as HTMLElement).innerText || e.textContent || e.getAttribute("title") || "").split("\n")[0]) === m);
      if (!el) { out[m] = "absent"; continue; }
      let why = "";
      for (let p: Element | null = el; p && !why; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === "none") why = `display none at ${p.tagName.toLowerCase()}.${String(p.className).slice(0, 60)}`;
        else if (s.visibility === "hidden") why = "visibility hidden";
        else if (Number(s.opacity) < 0.05) why = `opacity 0 at ${p.tagName.toLowerCase()}.${String(p.className).slice(0, 60)}`;
      }
      if (!why && getComputedStyle(el).pointerEvents === "none") why = "pointer events none";
      if (!why && (el as HTMLButtonElement).disabled) why = "disabled";
      out[m] = why || `shown ${el.tagName.toLowerCase()}`;
    }
    return out;
  }, missing);
}

test.describe.configure({ mode: "serial" });
test.setTimeout(30 * 60_000);

test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const fwd: Record<string, string> = process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() };
  ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: fwd, viewport: { width: 1280, height: 860 } });
  const p = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const s = Date.now().toString(36);
  expect((await p.request.post("/api/auth/sign-up/email", { data: { name: "Pat Parity", email: `owner-par1-${s}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await p.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const c = await (await p.request.post("/api/contacts", { data: { email: "ana@client.example", name: "Ana Client" }, headers })).json().catch(() => ({}));
  const t = await (await p.request.post("/api/tasks", { data: { title: "Prepare the board pack" }, headers })).json().catch(() => ({}));
  const d = await (await p.request.post("/api/docs", { data: { title: "Q4 plan", text: "Targets for the quarter." }, headers })).json().catch(() => ({}));
  const contactId = c?.contact?.id ?? c?.id; const taskRef = t?.task?.ref ?? t?.task?.id ?? t?.id; const docId = d?.doc?.id;
  pages = [
    ["my-work", "/app/my-work"], ["mail", "/app/mail"], ["inbox", "/app/inbox"], ["tasks", "/app/tasks?view=list"], ["board", "/app/tasks?view=board"],
    ...(taskRef ? [["task", `/app/tasks/${taskRef}`] as [string, string]] : []),
    ["docs", "/app/docs"], ...(docId ? [["doc", `/app/docs/${docId}`] as [string, string]] : []),
    ["calendar", "/app/tasks?view=calendar"], ["meetings", "/app/meetings"], ["social-compose", "/app/social/compose"],
    ["contacts", "/app/contacts"], ...(contactId ? [["contact", `/app/contacts/${contactId}`] as [string, string]] : []),
    ["chat", "/app/chat"], ["settings", "/app/settings"], ["account", "/app/settings/account"], ["billing", "/app/settings/billing"],
    ["notifications", "/app/notifications"], ["portals", "/app/contacts/portals"],
  ];
  const state = await ctx.storageState();
  phone = await browser.newContext({ baseURL: base, extraHTTPHeaders: fwd, storageState: state, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
});
test.afterAll(async () => {
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`PAR1 GAPS ${report.reduce((a, r) => a + r.missing.length, 0)}`);
  await ctx?.close(); await phone?.close();
});

test("every desktop action is reachable on a phone (390, touch)", async () => {
  const dp = await ctx.newPage(); const pp = await phone.newPage();
  for (const [name, path] of pages) {
    await dp.goto(path); await dp.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {}); await dp.waitForTimeout(400);
    const desk = (await names(dp, "main", { touch: false })).filter((n) => !DESKTOP_ONLY.some((r) => r.test(n)));
    await pp.goto(path); await pp.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {}); await pp.waitForTimeout(400);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await dp.screenshot({ path: `${SHOTS}/par1-${name}-1280.png` }); await pp.screenshot({ path: `${SHOTS}/par1-${name}-390.png` }); }
    const reach = await phoneReach(pp);
    const missing = desk.filter((n) => !reach.has(n) && ![...reach].some((r) => r.startsWith(n) || n.startsWith(r) && r.length > 3));
    report.push({ page: name, desktop: desk, missing, why: missing.length ? await whyMissing(pp, missing) : undefined });
  }
  if (!AUDIT) expect(report.filter((r) => r.missing.length).map((r) => `${r.page}: ${r.missing.join(" | ")}`)).toEqual([]);
});
