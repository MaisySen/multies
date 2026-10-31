import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R87: Tools > Links. Short links with UTM and a QR download, the redirect and its click stats, a bio page from draft to
 * live, a go link to a doc from the address bar and the command menu. Needs a server with Tools on and the links feature
 * (LINKS_E2E=1, E2E_BASE_URL). SHOTS_DIR=<dir> also writes the 1280 and 390 screenshots (light, dark, Forest) and runs axe.
 */
test.skip(process.env.LINKS_E2E !== "1", "needs a server with Tools and the links feature on");
test.describe.configure({ mode: "serial" });
const DIR = process.env.SHOTS_DIR;
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

async function signIn(page: Page, who = "Olive Harbour") {
  const email = `links${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: who, email, password: "a-strong-password" } })).status()).toBe(200);
  expect((await page.request.post("/api/account/onboarding", { data: { name: who, timezone: "Australia/Sydney", locale: "en-AU", company: "Harbour Coffee", workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
}

async function click(page: Page, code: string, h: Record<string, string>) {
  return page.request.get(`/l/${code}`, { maxRedirects: 0, headers: { "user-agent": PHONE, ...h } });
}

test("short link: make with UTM, copy, QR download, redirect counts a person and not a bot", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page);
  await page.goto("/app/tools/links");
  await expect(page.getByTestId("links-page")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("links-empty-new")).toBeVisible();

  // N opens the dialog from the keyboard.
  await page.keyboard.press("n");
  await expect(page.getByTestId("link-dialog")).toBeVisible();
  await page.getByTestId("link-url").fill("harbour.example/spring");
  await page.getByTestId("link-code").fill("spring sale");
  await expect(page.getByTestId("link-code")).toHaveValue("spring-sale");
  await page.getByTestId("link-more").click();
  await page.getByTestId("utm-source").fill("newsletter");
  await page.getByTestId("utm-medium").fill("email");
  await expect(page.getByTestId("utm-preview")).toContainText("https://harbour.example/spring?utm_source=newsletter&utm_medium=email");
  await page.getByTestId("link-save").click();
  await expect(page.getByText("Link made and copied")).toBeVisible();
  await expect(page.getByTestId("link-panel")).toBeVisible();
  await expect(page.getByTestId("link-row")).toHaveCount(1);
  await expect(page.getByTestId("link-row")).toContainText("/spring-sale");

  // Esc closes the panel; a taken back half is caught while typing.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("link-panel")).toBeHidden();
  await page.getByTestId("links-new").locator("visible=true").click();
  await page.getByTestId("link-url").fill("https://harbour.example/");
  await page.getByTestId("link-code").fill("spring-sale");
  await expect(page.getByText("This back half is taken. Try another.")).toBeVisible();
  await expect(page.getByTestId("link-save")).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByTestId("link-row").first().getByRole("button").first().click();

  // QR: PNG and SVG download.
  await page.getByTestId("panel-qr").click();
  await expect(page.getByTestId("qr-panel").getByRole("img")).toBeVisible();
  const [png] = await Promise.all([page.waitForEvent("download"), page.getByTestId("qr-png").click()]);
  expect(png.suggestedFilename()).toBe("spring-sale-qr.png");
  const [svg] = await Promise.all([page.waitForEvent("download"), page.getByTestId("qr-svg").click()]);
  expect(svg.suggestedFilename()).toBe("spring-sale-qr.svg");

  // The redirect: a person counts, a chat preview does not.
  const r = await click(page, "spring-sale", { "x-forwarded-for": "203.0.113.20", "cf-ipcountry": "NZ", referer: "https://www.instagram.com/" });
  expect(r.status()).toBe(302);
  expect(r.headers().location).toBe("https://harbour.example/spring?utm_source=newsletter&utm_medium=email");
  expect((await click(page, "spring-sale", { "user-agent": "facebookexternalhit/1.1" })).status()).toBe(302);
  await page.waitForTimeout(1200);
  await page.getByTestId("panel-stats").click();
  await expect(page.getByTestId("link-stats")).toBeVisible();
  await expect(page.getByTestId("link-stats")).toContainText("New Zealand");
  await expect(page.getByTestId("link-stats")).toContainText("instagram.com");
  const csv = await page.request.get(page.url().replace(/\/app.*/, "") + (await page.getByTestId("stats-csv").getAttribute("href")));
  expect(await csv.text()).toContain("NZ,instagram.com,Phone,Safari,iOS");

  // Turn off, then the link says so; Undo is offered.
  await page.getByTestId("panel-details").click();
  await page.getByTestId("link-toggle").click();
  await expect(page.getByText("Link turned off")).toBeVisible();
  const off = await click(page, "spring-sale", {});
  expect(off.status()).toBe(410);
  // Esc closes the panel.
  await page.getByTestId("link-panel").focus();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("link-panel")).toBeHidden();
});

test("bio page: draft, live preview, go live, public page and a counted click", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, "Maya Reid");
  await page.goto("/app/tools/links?tab=bio");
  await expect(page.getByTestId("bio-editor")).toBeVisible({ timeout: 20_000 });
  const slug = `maya${Date.now().toString(36)}`;
  await page.getByTestId("bio-slug").fill(slug);
  await page.getByTestId("bio-title").fill("Maya Reid");
  await page.getByTestId("bio-text").fill("Ceramics in Hobart. Studio open Saturdays.");
  await page.getByTestId("bio-add").click();
  const item = page.getByTestId("bio-item").first();
  await item.getByLabel("Button text").fill("Shop the new range");
  await item.getByLabel("Address").fill("https://maya.example/shop");
  await expect(page.getByTestId("bio-preview")).toContainText("Shop the new range");
  await expect(page.getByTestId("bio-preview")).toContainText("Ceramics in Hobart");
  await page.getByTestId("bio-publish").click();
  await expect(page.getByText("Page saved and live")).toBeVisible();
  const pub = await page.request.get(`/bio/${slug}`, { headers: { "user-agent": MAC } });
  expect(pub.status()).toBe(200);
  const html = await pub.text();
  expect(html).toContain("Shop the new range");
  expect(html).not.toContain("<script");
  const go = html.match(/href="[^"]*(\/bio\/[^"]+\/go\/[^"]+)"/)![1];
  const hop = await page.request.get(go, { maxRedirects: 0, headers: { "user-agent": MAC } });
  expect(hop.status()).toBe(302);
  expect(hop.headers().location).toBe("https://maya.example/shop");
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByTestId("bio-item").first()).toContainText("1 click");
});

test("go link: make one to a doc, open it from the address bar and the command menu", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, "Theo Lane");
  const origin = new URL(baseURL!).origin;
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Onboarding handbook", text: "Start here." }, headers: { origin } })).json()) as { doc: { id: string } };
  await page.goto("/app/tools/links?tab=go");
  await expect(page.getByTestId("go-links")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("go-new").click();
  await page.getByTestId("go-name").fill("onboarding");
  await page.getByTestId("go-kind-url").click();
  await page.getByTestId("go-kind-doc").click();
  await page.getByTestId("go-find").fill("Onboarding");
  await page.getByRole("option", { name: /Onboarding handbook/ }).click();
  await page.getByTestId("go-save").click();
  await expect(page.getByText("go/onboarding is ready")).toBeVisible();
  await expect(page.getByTestId("go-row")).toContainText("go/onboarding");
  await page.goto("/go/onboarding");
  await expect(page).toHaveURL(new RegExp(`/app/docs/${doc.doc.id}`), { timeout: 15_000 });
  // A near miss offers the right name.
  await page.goto("/app/go/onboard");
  await expect(page.getByTestId("go-missing")).toContainText("go/onboarding");
  // Command menu.
  await page.goto("/app/tools/links?tab=go");
  await expect(page.getByTestId("go-row")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("go/onboarding");
  await page.getByTestId("palette-go-links").getByRole("option", { name: /go\/onboarding/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/docs/${doc.doc.id}`), { timeout: 15_000 });
});

test("screenshots at 1280 and 390, light, dark and Forest, and axe finds nothing serious", async ({ page, baseURL }) => {
  test.skip(!DIR, "screenshots only with SHOTS_DIR");
  test.setTimeout(300_000);
  mkdirSync(DIR!, { recursive: true });
  const origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page);
  const headers = { origin };
  const mk = async (data: Record<string, unknown>) => ((await (await page.request.post("/api/links", { data, headers })).json()) as { link: { id: string; code: string } }).link;
  const main = await mk({ url: "https://harbourcoffee.example/spring?utm_source=newsletter&utm_medium=email", code: "spring", title: "Spring menu email", tags: ["email", "spring"] });
  await mk({ url: "https://harbourcoffee.example/wholesale", code: "wholesale", title: "Wholesale enquiry form", tags: ["sales"], maxClicks: 200 });
  await mk({ url: "https://instagram.com/harbourcoffee", title: "Instagram profile", tags: ["social"] });
  await mk({ url: "https://harbourcoffee.example/careers", code: "barista-jobs", title: "Barista jobs", password: "beans2026", expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString() });
  const countries = ["AU", "AU", "AU", "NZ", "NZ", "US", "GB", "AU", "SG", "AU"];
  const refs = ["https://www.instagram.com/", "https://l.facebook.com/", "", "https://www.google.com/", "https://www.instagram.com/"];
  for (let i = 0; i < 34; i++) {
    await click(page, i % 5 === 4 ? "wholesale" : "spring", { "x-forwarded-for": `198.51.100.${i % 23}`, "cf-ipcountry": countries[i % countries.length], referer: refs[i % refs.length], "user-agent": i % 3 === 0 ? MAC : PHONE });
  }
  await click(page, "spring", { "user-agent": "Slackbot-LinkExpanding 1.0" });
  await page.request.put("/api/links/bio?scope=me", { headers, data: {
    slug: `harbour${Date.now().toString(36)}`, title: "Harbour Coffee", bio: "Small batch roasters on the waterfront. Open 7 till 3, every day.", avatar: "photo", theme: "brand", published: true,
    items: [{ title: "Order for pickup", url: "https://harbourcoffee.example/order", icon: "shop" }, { title: "This month's beans", url: "https://harbourcoffee.example/beans", icon: "star" }, { title: "Book a cupping class", url: "https://harbourcoffee.example/classes", icon: "calendar" }, { title: "Find us", url: "https://maps.example/harbour", icon: "map" }],
    socials: [{ kind: "instagram", url: "https://instagram.com/harbourcoffee" }, { kind: "facebook", url: "https://facebook.com/harbourcoffee" }, { kind: "email", url: "hello@harbourcoffee.example" }],
  } });
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Onboarding handbook", text: "Start here." }, headers })).json()) as { doc: { id: string } };
  await page.request.post("/api/links/go", { headers, data: { name: "onboarding", targetKind: "doc", targetId: doc.doc.id, description: "Start here if you are new" } });
  await page.request.post("/api/links/go", { headers, data: { name: "roster", targetKind: "url", url: "https://roster.example/harbour", description: "This week's shifts" } });
  await page.request.post("/api/links/go", { headers, data: { name: "suppliers", targetKind: "url", url: "https://docs.example/suppliers" } });
  await page.waitForTimeout(1200);

  const shot = async (name: string) => { await page.waitForLoadState("networkidle").catch(() => undefined); await page.waitForTimeout(400); await page.screenshot({ path: `${DIR}/${name}.png` }); };
  const axe = async (label: string) => {
    const { violations } = await new AxeBuilder({ page }).include("main").analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`)).toEqual([]);
  };
  // After shots of the screens that existed before: the Tools page card and the Create menu item.
  await page.goto("/app/tools");
  const card = page.getByText("Short links, QR codes, stats and a bio page").first();
  await card.scrollIntoViewIfNeeded({ timeout: 20_000 });
  await expect(card).toBeVisible();
  await shot("l00-after-tools-card-1280-light");
  await page.getByTestId("create-menu").click();
  await expect(page.getByRole("menuitem", { name: "Short link" })).toBeVisible();
  await shot("l00-after-create-menu-1280-light");
  await page.keyboard.press("Escape");
  const views = async (suffix: string, withAxe: boolean) => {
    await page.goto("/app/tools/links");
    await expect(page.getByTestId("link-row").first()).toBeVisible({ timeout: 20_000 });
    await shot(`l01-list-${suffix}`); if (withAxe) await axe(`list ${suffix}`);
    await page.goto(`/app/tools/links?link=${main.id}`);
    await page.getByTestId("panel-stats").click();
    await expect(page.getByTestId("link-stats")).toContainText("Australia");
    await shot(`l02-stats-${suffix}`); if (withAxe) await axe(`stats ${suffix}`);
    await page.getByTestId("panel-qr").click();
    await shot(`l03-qr-${suffix}`);
    await page.goto("/app/tools/links?tab=bio");
    await expect(page.getByTestId("bio-item").first()).toBeVisible();
    await shot(`l04-bio-${suffix}`); if (withAxe) await axe(`bio ${suffix}`);
    await page.goto("/app/tools/links?tab=go");
    await expect(page.getByTestId("go-row").first()).toBeVisible();
    await shot(`l05-go-${suffix}`); if (withAxe) await axe(`go ${suffix}`);
    await page.goto("/app/tools/links?tab=domain");
    await expect(page.getByTestId("links-domain")).toBeVisible();
    await shot(`l06-domain-${suffix}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await views(`${w}-${scheme}`, true);
    }
  }
  // The dialog and the public bio page.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/tools/links?new=1");
  await page.getByTestId("link-url").fill("https://harbourcoffee.example/autumn");
  await page.getByTestId("link-more").click();
  await page.getByTestId("utm-source").fill("instagram");
  await page.getByTestId("utm-campaign").fill("autumn_launch");
  await shot("l07-new-1280-light");
  await page.setViewportSize({ width: 390, height: 844 });
  const bio = (await (await page.request.get("/api/links/bio?scope=me")).json()) as { page: { url: string } };
  await page.goto(bio.page.url.replace(/^https?:\/\/[^/]+/, ""));
  await shot("l08-public-bio-390-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("l08-public-bio-390-dark");

  // Forest.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await views("1280-forest", true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(bio.page.url.replace(/^https?:\/\/[^/]+/, ""));
  await shot("l09-public-bio-390-forest");
});
