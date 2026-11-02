import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmEmail } from "./support/confirm-email";

/**
 * R121 (layout plan P2, NAV_P2_R121): one menu model. Rail at 1280 and the More sheet at 390 for an owner and a member,
 * Contacts as its own section, Settings > Mail setup, Files in Docs, hide and reset, old addresses redirect (client and
 * server), the command menu goes to the new places, and with the switch off (E2E_NAV_P2=off) the old navigation shows.
 * With SHOTS_DIR set it saves the UX gate screenshots (1280 and 390, light, dark, Forest).
 */
const OFF = process.env.E2E_NAV_P2 === "off";
const DIR = process.env.SHOTS_DIR;
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;

async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/app/my-work");
  return origin;
}
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function person(browser: Browser, origin: string, email: string, name: string, width: number) {
  const ctx = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "x-forwarded-for": ip() }, viewport: { width, height: width === 390 ? 844 : 860 } });
  const page = await ctx.newPage();
  const headers = { origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}
/** A real workspace (invites are off in the demo) and a member who joined it. */
async function memberPage(browser: Browser, origin: string, width: number) {
  const owner = await person(browser, origin, `own-r121-${uniq()}@acme.io`, "Olive Owner", 1280);
  const email = `mem-r121-${uniq()}@acme.io`;
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email, role: "member" }, headers: owner.headers })).json();
  const m = await person(browser, origin, email, "Max Member", width);
  await confirmEmail(m.page.request, email);
  expect((await m.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: m.headers })).status()).toBe(200);
  const me = await (await m.page.request.get("/api/account/me")).json();
  expect(me.organization?.role).toBe("member");
  await owner.ctx.close();
  return { ctx: m.ctx, page: m.page };
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function axe(page: Page, where: string, include = "main") {
  // Let the page's entrance fade finish: a half faded heading reads as low contrast.
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(700);
  const { violations } = await new AxeBuilder({ page }).include(include).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
const RAIL = ["home", "mail", "chat", "tasks", "docs", "social", "contacts"];

test.describe("R121 P2 navigation on", () => {
  test.skip(OFF, "runs with the switch on (the default e2e server)");

  test("1280 owner: rail, Contacts, Mail setup, Files in Docs, redirects, command menu, hide and reset", async ({ page, context }) => {
    test.setTimeout(240_000);
    await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: 1280, height: 860 });
    await demo(page);
    const cfg = await (await page.request.get("/api/config")).json();
    expect(cfg.navP2).toBe(true);

    // The rail in the plan's order; Agents and Settings at the bottom.
    const rail = page.getByTestId("icon-rail");
    await expect(rail.getByTestId("rail-contacts")).toBeVisible();
    const ids = await rail.locator("[data-testid^=rail-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice(5)));
    expect(ids.filter((x) => RAIL.includes(x))).toEqual(RAIL);
    await expect(page.getByTestId("rail-bottom").getByTestId("rail-agents")).toBeVisible();
    await expect(page.getByTestId("rail-bottom").getByTestId("rail-workspace")).toHaveText(/Settings/);
    await shot(page, "rail-1280-light");

    // Contacts: its own section with People and Deals; Chat no longer lists it; Mail keeps only daily pages.
    await rail.getByTestId("rail-contacts").click();
    await expect(page).toHaveURL(/\/app\/contacts$/);
    await expect(page.getByTestId("rail-contacts")).toHaveAttribute("aria-current", "page");
    const side = page.getByRole("complementary", { name: "Sidebar" });
    await expect(side.getByRole("link", { name: "People" })).toBeVisible();
    await side.getByRole("link", { name: "Deals" }).click();
    await expect(page).toHaveURL(/\/app\/deals$/);
    await expect(page.getByTestId("rail-contacts")).toHaveAttribute("aria-current", "page");
    await shot(page, "contacts-deals-1280-light");
    await rail.getByTestId("rail-chat").click();
    await expect(side.getByRole("link", { name: "Meetings" })).toBeVisible();
    await expect(side.getByRole("link", { name: "Contacts" })).toHaveCount(0);
    await page.goto("/app/inbox");
    await expect(side.getByRole("link", { name: "Shared inbox" })).toBeVisible();
    await expect(side.getByRole("link", { name: "Mailboxes" })).toHaveCount(0);
    await expect(side.getByRole("link", { name: "Domains" })).toHaveCount(0);

    // Files sits in Docs (when this workspace has Files), never in Tools.
    const files = !!cfg.tools && (!!cfg.filesPlus || (cfg.toolFeatures ?? []).includes("folders"));
    await page.goto("/app/docs");
    await expect(side.getByRole("link", { name: "Files" })).toHaveCount(files ? 1 : 0);
    if (files) {
      await side.getByRole("link", { name: "Files" }).click();
      await expect(page).toHaveURL(/\/app\/files/);
      await expect(page.getByTestId("rail-docs")).toHaveAttribute("aria-current", "page");
      await shot(page, "docs-files-1280-light");
    }
    if (cfg.tools) { await page.goto("/app/tools"); await expect(side.getByRole("link", { name: "Files" })).toHaveCount(0); }

    // Settings > Mail setup: Mailboxes, Domains, Deliverability, Routing, inside the one Settings sidebar.
    await page.goto("/app/settings");
    const list = page.getByTestId("settings-rail");
    await expect(list.getByText("Mail setup", { exact: true })).toBeVisible();
    for (const name of ["Mailboxes", "Domains", "Deliverability", "Routing"]) await expect(list.getByRole("link", { name, exact: true })).toBeVisible();
    await list.getByRole("link", { name: "Domains", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/settings\/domains$/);
    await expect(page.getByTestId("settings-title")).toHaveText("Domains");
    await expect(page.getByRole("button", { name: /add domain/i }).first()).toBeVisible();
    await expect(page).toHaveTitle(/Domains · Settings · Multies$/);
    await shot(page, "settings-domains-1280-light");
    await list.getByRole("link", { name: "Mailboxes", exact: true }).click();
    await expect(page.getByTestId("settings-title")).toHaveText("Mailboxes");
    await shot(page, "settings-mailboxes-1280-light");
    await list.getByRole("link", { name: "Deliverability", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/settings\/deliverability$/);
    expect(await axe(page, "deliverability")).toEqual([]);

    // Old addresses redirect in the app (query kept) and from the server (302, ids kept).
    await page.goto("/app/mailboxes?tab=aliases");
    await expect(page).toHaveURL(/\/app\/settings\/mailboxes\?tab=aliases$/);
    await page.goto("/app/domains");
    await expect(page).toHaveURL(/\/app\/settings\/domains$/);
    await page.goto("/app/deliverability");
    await expect(page).toHaveURL(/\/app\/settings\/deliverability$/);
    const r = await page.request.get("/app/domains/dom_123?check=1", { maxRedirects: 0 });
    expect(r.status()).toBe(302);
    expect(r.headers().location).toBe("/app/settings/domains/dom_123?check=1");

    // The command menu takes you to the new place.
    await page.goto("/app/my-work");
    await expect(page.getByTestId("rail-home")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox").first()).toBeVisible();
    await page.getByRole("combobox").first().fill("Deliverability");
    await page.getByRole("option", { name: /^Deliverability/ }).first().click();
    await expect(page).toHaveURL(/\/app\/settings\/deliverability$/);

    // The menu model the mobile app reads.
    const menu = await (await page.request.get("/api/nav/menu")).json();
    expect(menu.navP2).toBe(true);
    expect(menu.sections.map((s: { id: string }) => s.id).slice(0, 7)).toEqual(RAIL);

    // Hide Contacts from View > Customise menu; it stays while you are in it; Reset brings it back.
    await page.goto("/app/my-work");
    await page.getByTestId("view-menu").click();
    await page.getByRole("menuitem", { name: "Customise menu" }).click();
    const dlg = page.getByTestId("customise-menu");
    await expect(dlg).toBeVisible();
    await shot(page, "customise-1280-light");
    expect(await axe(page, "customise dialog", "dialog")).toEqual([]);
    await dlg.getByRole("switch", { name: "Show Contacts" }).click();
    await expect(dlg.getByRole("switch", { name: "Show Contacts" })).toHaveAttribute("aria-checked", "false");
    await expect(dlg.getByRole("switch", { name: "Show Home" })).toHaveCount(0);
    await page.getByTestId("customise-done").click();
    await expect(rail.getByTestId("rail-contacts")).toHaveCount(0);
    await page.goto("/app/contacts");
    await expect(rail.getByTestId("rail-contacts")).toHaveAttribute("aria-current", "page");
    await page.goto("/app/my-work");
    await expect(rail.getByTestId("rail-contacts")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("rail-home")).toBeVisible();
    await expect(rail.getByTestId("rail-contacts")).toHaveCount(0); // kept for this person
    await page.getByTestId("view-menu").click();
    await page.getByRole("menuitem", { name: "Customise menu" }).click();
    await page.getByTestId("customise-reset").click();
    await page.getByTestId("customise-done").click();
    await expect(rail.getByTestId("rail-contacts")).toBeVisible();

    // Light, dark and the Forest brand: axe clean on the changed screens.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [path, name] of [["/app/deals", "deals"], ["/app/contacts", "contacts"], ["/app/settings/domains", "settings-domains"], ["/app/settings/mailboxes", "settings-mailboxes"]] as const) {
        await page.goto(path);
        expect(await noSideScroll(page), `${path} ${scheme}`).toBe(true);
        if (scheme === "dark") await shot(page, `${name}-1280-dark`);
        expect(await axe(page, `${name} ${scheme}`)).toEqual([]);
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/app/settings/branding");
    await page.getByRole("button", { name: "Forest", exact: true }).click();
    await page.getByRole("button", { name: "Save brand" }).click();
    await page.waitForTimeout(800);
    for (const [path, name] of [["/app/contacts", "contacts"], ["/app/settings/domains", "settings-domains"]] as const) {
      await page.goto(path); await shot(page, `${name}-1280-forest`);
      expect(await axe(page, `${name} forest`)).toEqual([]);
    }
  });

  test("390 owner: tab bar, More tiles with counts, a section list, New social post, Settings, fourth tab", async ({ page, context }) => {
    test.setTimeout(180_000);
    await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    const bar = page.getByTestId("phone-tabbar");
    for (const id of ["home", "mail", "chat", "tasks", "more"]) await expect(bar.getByTestId(`tab-${id}`)).toBeVisible();
    await expect(bar.getByTestId("tab-calendar")).toHaveCount(0);
    const nav = page.getByRole("dialog", { name: "Navigation" });
    await bar.getByTestId("tab-chat").click();
    await expect(page).toHaveURL(/\/app\/chat/);
    await expect(bar.getByTestId("tab-chat")).toHaveAttribute("aria-current", "page");

    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/app/my-work");
      await bar.getByTestId("tab-more").click();
      const sheet = page.getByRole("dialog", { name: "Navigation" }).getByTestId("more-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet.getByTestId("more-tile-contacts")).toBeVisible();
      await expect(sheet.getByTestId("more-tile-workspace")).toHaveCount(0); // Settings is its own row
      expect(await noSideScroll(page)).toBe(true);
      await shot(page, `more-390-${scheme}`);
      expect(await axe(page, `more ${scheme}`, "[role=dialog]")).toEqual([]);
      const box = await sheet.getByTestId("more-tile-contacts").boundingBox();
      expect(box && box.height >= 44 && box.width >= 44).toBe(true);
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.goto("/app/my-work");
    }
    await page.emulateMedia({ colorScheme: "light" });

    // The tile count is the rail's count (Home: what needs you, else nothing).
    await bar.getByTestId("tab-more").click();
    const sheet = page.getByRole("dialog", { name: "Navigation" }).getByTestId("more-sheet");
    const label = await sheet.getByTestId("more-tile-home").getAttribute("aria-label");
    expect(label).toMatch(/^Home(, \d+ (need you|unread))?$/);
    // A section with several pages opens its list; Back returns; a page opens and closes the sheet.
    await sheet.getByTestId("more-tile-contacts").click();
    const sec = page.getByRole("dialog", { name: "Navigation" }).getByTestId("more-section");
    await expect(sec.getByRole("heading", { name: "Contacts" })).toBeVisible();
    await expect(sec.getByTestId("more-back")).toBeFocused();
    await shot(page, "more-contacts-390-light");
    await sec.getByTestId("more-back").click();
    await sheet.getByTestId("more-tile-contacts").click();
    await sec.getByRole("link", { name: "Deals" }).click();
    await expect(page).toHaveURL(/\/app\/deals$/);
    await expect(page.getByRole("dialog", { name: "Navigation" })).toHaveCount(0);
    // New social post and Settings sit under the tiles.
    await bar.getByTestId("tab-more").click();
    await expect(nav.getByTestId("more-new-post")).toBeVisible();
    await nav.getByTestId("more-settings").click();
    await expect(page).toHaveURL(/\/app\/settings$/);
    await expect(page.getByTestId("settings-hub").getByText("Mail setup", { exact: true })).toBeVisible();
    await page.getByTestId("settings-hub").getByRole("link", { name: "Domains", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/settings\/domains$/);
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, "settings-domains-390-light");
    expect(await axe(page, "domains 390")).toEqual([]);

    // Customise: Social as the fourth tab, then Reset.
    await page.goto("/app/my-work");
    await bar.getByTestId("tab-more").click();
    await nav.getByTestId("more-customise").click();
    await page.getByTestId("fourth-tab").getByRole("radio", { name: "Social" }).click();
    await page.getByTestId("customise-done").click();
    await expect(bar.getByTestId("tab-social")).toBeVisible();
    await expect(bar.getByTestId("tab-tasks")).toHaveCount(0);
    await bar.getByTestId("tab-more").click();
    await nav.getByTestId("more-customise").click();
    await page.getByTestId("customise-reset").click();
    await page.getByTestId("customise-done").click();
    await expect(bar.getByTestId("tab-tasks")).toBeVisible();
  });

  test("member: same places, nothing new (no Operator), Mail setup as before", async ({ page, context, browser }) => {
    test.setTimeout(150_000);
    await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.goto("/login");
    const m = await memberPage(browser, new URL(page.url()).origin, 1280);
    await m.page.goto("/app/my-work");
    const rail = m.page.getByTestId("icon-rail");
    await expect(rail.getByTestId("rail-contacts")).toBeVisible();
    const menu = await (await m.page.request.get("/api/nav/menu")).json();
    const pages = menu.sections.flatMap((s: { pages: { to: string }[] }) => s.pages.map((p) => p.to));
    expect(pages).not.toContain("/app/admin");
    await m.page.goto("/app/settings");
    await expect(m.page.getByTestId("settings-rail").getByRole("link", { name: "Operator" })).toHaveCount(0);
    await expect(m.page.getByTestId("settings-rail").getByRole("link", { name: "Mailboxes", exact: true })).toBeVisible();
    await m.page.goto("/app/settings/deliverability");
    await expect(m.page.getByTestId("settings-title")).toHaveText("Deliverability");
    expect(await axe(m.page, "member deliverability")).toEqual([]);
    await shot(m.page, "member-settings-deliverability-1280-light");
    // Phone More for the member.
    await m.page.setViewportSize({ width: 390, height: 844 });
    await m.page.goto("/app/my-work");
    await m.page.getByTestId("tab-more").click();
    await expect(m.page.getByRole("dialog", { name: "Navigation" }).getByTestId("more-tile-contacts")).toBeVisible();
    await shot(m.page, "member-more-390-light");
    await m.ctx.close();
  });
});

test.describe("R121 switch off: the old navigation, unchanged", () => {
  test.skip(!OFF, "runs only with E2E_NAV_P2=off");
  test("rail, phone list and old addresses as before", async ({ page, context }) => {
    test.setTimeout(120_000);
    await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: 1280, height: 860 });
    await demo(page);
    expect((await (await page.request.get("/api/config")).json()).navP2).toBe(false);
    const rail = page.getByTestId("icon-rail");
    await expect(rail.getByTestId("rail-chat")).toBeVisible();
    const ids = await rail.locator("[data-testid^=rail-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice(5)));
    expect(ids.filter((x) => ["home", "mail", "tasks", "docs", "social", "chat"].includes(x))).toEqual(["home", "mail", "tasks", "docs", "social", "chat"]);
    await expect(rail.getByTestId("rail-contacts")).toHaveCount(0);
    await page.goto("/app/domains");
    await expect(page).toHaveURL(/\/app\/domains$/);
    const r = await page.request.get("/app/domains", { maxRedirects: 0 });
    expect(r.status()).toBe(200);
    await page.goto("/app/mail");
    await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Mailboxes" })).toBeVisible().catch(async () => {
      // Mail folds the shell sidebar by default; the Mail section still lists its setup pages.
      await page.goto("/app/inbox");
      await expect(page.getByRole("complementary", { name: "Sidebar" }).getByRole("link", { name: "Mailboxes" })).toBeVisible();
    });
    await page.goto("/app/settings");
    await expect(page.getByTestId("settings-rail").getByText("Mail setup", { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/app/my-work");
    await expect(page.getByTestId("tab-calendar")).toBeVisible();
    await page.getByTestId("tab-more").click();
    await expect(page.getByRole("dialog", { name: "Navigation" }).getByTestId("more-sheet")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Navigation" }).getByTestId("nav-group").first()).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Navigation" }).getByRole("link", { name: "Contacts" })).toBeVisible();
  });
});
