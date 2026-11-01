import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R115 maps (MAPS_R115=on MAPS_GEO_MOCK=1 in the e2e server: lookups answer from a fixed local list, no network).
 * Map tiles are served by a stub style here, so no request leaves the machine. Flows: a contact's address picked from
 * suggestions with a map and directions; no match saved as typed, removed with undo; Visits with the shortest order and
 * maps app links; a booking page meeting place shown to guests. SHOTS_DIR writes shots at 1280 and 390, light, dark and
 * Forest, and runs axe (serious or critical fails).
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.195.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.route("https://tiles.openfreemap.org/**", (r) => r.fulfill({ json: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": r.request().url().includes("dark") ? "#1d2430" : "#e9eef2" } }] } }));
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(400); // let colour transitions (theme switch) settle so axe reads the final colours
  const { violations } = await new AxeBuilder({ page }).exclude(".maplibregl-canvas").exclude("[data-sonner-toaster]") /* toasts fade in and out; mid fade colours are not real */.analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string, full = false) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
async function contacts(page: Page) {
  const r = await page.request.get("/api/contacts");
  return ((await r.json()) as { contacts: { id: string; name: string; email: string }[] }).contacts;
}

test("contact address: pick a suggestion, see the map and directions; no match saved as typed; remove with undo", async ({ page }) => {
  await demo(page);
  const [first] = await contacts(page);
  await page.goto(`/app/contacts/${first.id}`);
  const card = page.getByTestId("address-card-contact");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Add an address to see it on a map");
  await card.getByTestId("address-add").click();
  const box = card.getByRole("combobox", { name: "Address" });
  await expect(box).toBeFocused();
  await box.fill("12 harbour street");
  const options = page.getByRole("listbox", { name: "Matching addresses" }).getByRole("option");
  await expect(options.first()).toContainText("12 Harbour Street", { timeout: 10_000 });
  await expect(page.getByText("Map data from OpenStreetMap contributors").first()).toBeVisible();
  // Nothing is highlighted until ArrowDown, so ArrowDown then Enter saves the first row shown (verifier v8, 00:38).
  await expect(options.first()).toHaveAttribute("aria-selected", "false");
  await box.press("ArrowDown");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await expect(card.getByText("Map pin found.")).toBeVisible();
  await card.getByTestId("address-save").click();
  await expect(card.getByTestId("address-text")).toHaveText("12 Harbour Street, Sydney NSW 2000, Australia");
  await expect(card.getByTestId("map")).toBeVisible();
  // Map credits: one small collapsed "i" button with underlined links, no library attribution box over the map.
  await expect(page.locator(".maplibregl-ctrl-attrib")).toHaveCount(0);
  const credits = card.getByRole("button", { name: "Map credits" });
  await expect(credits).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByTestId("map-credits")).toHaveCount(0);
  await credits.click();
  await expect(credits).toHaveAttribute("aria-expanded", "true");
  await expect(card.getByTestId("map-credits").getByRole("link", { name: "© OpenStreetMap contributors" })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
  await expect(card.getByTestId("map-credits").getByRole("link")).toHaveCount(3);
  await axe(page, "address card, map credits open");
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page, "address card, map credits open, dark");
  await page.emulateMedia({ colorScheme: "light" });
  await credits.click();
  await expect(card.getByTestId("map-credits")).toHaveCount(0);
  await expect(card.getByTestId("directions-google")).toHaveAttribute("href", /google\.com\/maps\/dir\/\?api=1&destination=-33\.\d+%2C151\.\d+/);
  await expect(card.getByTestId("directions-apple")).toHaveAttribute("href", /maps\.apple\.com\/\?daddr=-33\./);
  await noHScroll(page);

  // No match: kept as typed, without a pin.
  await card.getByRole("button", { name: "Change address" }).click();
  await box.fill("Back paddock, nowhere road");
  await expect(card.getByTestId("address-status")).toHaveText("No matches. Check the spelling, or keep the address as typed.", { timeout: 10_000 });
  // No empty listbox and no popup over Save (verifier v8 addendum: aria-required-children, click intercepted).
  await expect(page.getByRole("listbox", { name: "Matching addresses" })).toHaveCount(0);
  await expect(box).toHaveAttribute("aria-expanded", "false");
  await axe(page, "address search with no matches");
  await page.emulateMedia({ colorScheme: "dark" });
  await axe(page, "address search with no matches, dark");
  await page.emulateMedia({ colorScheme: "light" });
  await card.getByTestId("address-save").click({ timeout: 5_000 });
  await expect(page.getByText("Address saved without a map pin")).toBeVisible();
  await expect(card).toContainText("No map pin for this address yet");
  await expect(card.getByTestId("directions-google")).toHaveAttribute("href", /destination=Back%20paddock/);

  // Remove, then undo.
  await card.getByRole("button", { name: "Remove address" }).click();
  await expect(card.getByTestId("address-add")).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(card.getByTestId("address-text")).toHaveText("Back paddock, nowhere road");
});

test("visits: empty state, add stops, shortest order, maps app links, phone width", async ({ page }) => {
  await demo(page);
  await page.goto("/app/contacts?tab=visits");
  await expect(page.getByText("No addresses yet")).toBeVisible({ timeout: 20_000 });
  await shot(page, "visits-empty-1280-light");
  await axe(page, "visits empty");
  const people = (await contacts(page)).slice(0, 4);
  expect(people.length).toBeGreaterThanOrEqual(3);
  // A deliberately long order: west, east, middle, far east.
  const lons = [151.10, 151.30, 151.20, 151.40];
  for (const [i, p] of people.entries()) {
    const r = await page.request.put("/api/maps/places", { data: { entityType: "contact", entityId: p.id, address: `${i + 1} Visit Street, Sydney NSW`, lat: -33.87, lon: lons[i] } });
    expect(r.status()).toBe(200);
  }
  await page.reload();
  await expect(page.getByText("Who are you visiting?")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("visit-add").click();
  const dialog = page.getByRole("dialog", { name: "Add stops" });
  for (const p of people) await dialog.getByRole("checkbox", { name: new RegExp(p.name || p.email) }).check();
  await dialog.getByTestId("visit-add-confirm").click();
  const stops = page.getByTestId("visit-stops").getByRole("listitem");
  await expect(stops).toHaveCount(people.length);
  await expect(page.getByTestId("visit-summary")).toContainText("The shortest order saves about");
  await page.getByTestId("visit-best").click();
  await expect(page.getByText(/Shortest order set/)).toBeVisible();
  await expect(stops.nth(0)).toContainText("1 Visit Street");
  await expect(stops.nth(1)).toContainText("3 Visit Street");
  await expect(stops.nth(2)).toContainText("2 Visit Street");
  await expect(page.getByTestId("visit-best")).toBeDisabled();
  await expect(page.getByTestId("visit-best-why")).toHaveText("Already in the shortest order.");
  // Move a stop by keyboard reachable buttons, then back.
  await stops.nth(1).getByRole("button", { name: /Move .* down/ }).click();
  await expect(stops.nth(2)).toContainText("3 Visit Street");
  await page.getByTestId("visit-best").click();
  await expect(page.getByTestId("route-google").first()).toHaveAttribute("href", /google\.com\/maps\/dir\/\?api=1&origin=-33\.870000%2C151\.100000.*waypoints=/);
  await expect(page.getByTestId("route-apple").first()).toHaveAttribute("href", /maps\.apple\.com\/\?saddr=.*\+to:/);
  await expect(page.getByTestId("map")).toBeVisible();
  // The plan survives a reload.
  await page.reload();
  await expect(stops).toHaveCount(people.length, { timeout: 20_000 });
  await noHScroll(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await noHScroll(page);
  await expect(page.getByTestId("route-google").first()).toBeVisible();
});

test("booking page meeting place shows to guests with directions", async ({ page }) => {
  await demo(page);
  const slug = `maps-${Date.now().toString(36)}`;
  const r = await page.request.put("/api/scheduling/page", { data: { slug, title: "Site visit", timezone: "Australia/Sydney", hours: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] }, slotMin: 30, minNoticeMin: 0 } });
  expect(r.status()).toBe(200);
  await page.goto("/app/scheduling");
  const card = page.getByTestId("address-card-scheduling_page");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card).toContainText("Meeting place");
  await card.getByTestId("address-add").click();
  await card.getByRole("combobox").fill("10 pitt street");
  await page.getByRole("listbox", { name: "Matching addresses" }).getByRole("option").first().click();
  await card.getByTestId("address-save").click();
  await expect(card.getByTestId("address-text")).toContainText("10 Pitt Street");
  await page.goto(`/book/${slug}`);
  const loc = page.getByTestId("book-location");
  await expect(loc).toContainText("10 Pitt Street, Sydney NSW 2000, Australia", { timeout: 20_000 });
  await expect(loc.getByRole("link", { name: "Get directions" })).toHaveAttribute("href", /google\.com\/maps\/dir/);
  await axe(page, "booking page with place");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(loc).toBeVisible();
  await shot(page, "book-public-390-dark", true);
  await axe(page, "booking page with place, dark phone");
});

test("shots: contact, company, visits, booking settings at 1280 and 390, light, dark and Forest", async ({ page }) => {
  test.skip(!DIR, "SHOTS_DIR not set");
  test.setTimeout(300_000);
  await demo(page);
  const people = (await contacts(page)).slice(0, 5);
  for (const [i, p] of people.entries()) await page.request.put("/api/maps/places", { data: { entityType: "contact", entityId: p.id, address: `${i + 1} George Street, Sydney NSW 2000, Australia`, lat: -33.86 - i * 0.004, lon: 151.205 + ((i * 7) % 5) * 0.004 } });
  const company = (await (await page.request.post("/api/crm/companies", { data: { name: "Harbour Supplies" } })).json()) as { company: { id: string } };
  await page.request.put("/api/maps/places", { data: { entityType: "company", entityId: company.company.id, address: "Pier 2, Hickson Road, Walsh Bay NSW 2000, Australia", lat: -33.856, lon: 151.203 } });
  await page.request.put("/api/scheduling/page", { data: { slug: `shots-${Date.now().toString(36)}`, title: "Site visit", timezone: "Australia/Sydney", hours: { mon: [["09:00", "17:00"]] }, slotMin: 30, minNoticeMin: 0 } });
  await page.request.put("/api/maps/places", { data: { entityType: "scheduling_page", entityId: "mine", address: "Level 2, 10 Pitt Street, Sydney NSW 2000", lat: -33.865, lon: 151.208 } });
  await page.goto("/app/contacts?tab=visits");
  await page.getByTestId("visit-add").click();
  for (const p of people) await page.getByRole("dialog").getByRole("checkbox", { name: new RegExp(p.name || p.email) }).check();
  await page.getByTestId("visit-add-confirm").click();
  const pages: [string, string, string][] = [["contact", `/app/contacts/${people[0].id}`, "address-card-contact"], ["company", `/app/contacts/companies/${company.company.id}`, "address-card-company"], ["visits", "/app/contacts?tab=visits", "visits"], ["booking", "/app/scheduling", "address-card-scheduling_page"]];
  const run = async (theme: string) => {
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const [name, url, id] of pages) {
        await page.goto(url);
        await expect(page.getByTestId(id)).toBeVisible({ timeout: 20_000 });
        await noHScroll(page);
        if (w === 390 && name !== "visits") await page.getByTestId(id).scrollIntoViewIfNeeded();
        await shot(page, `${name}-${w}-${theme}`, w === 1280 && name !== "visits");
        await axe(page, `${name} ${w} ${theme}`);
      }
      await page.goto(`/app/contacts/${people[1].id}`);
      await page.getByTestId("address-card-contact").getByRole("button", { name: "Change address" }).click();
      await page.getByTestId("address-card-contact").getByRole("combobox").fill("45 kent street");
      await expect(page.getByRole("listbox", { name: "Matching addresses" }).getByRole("option").first()).toBeVisible({ timeout: 10_000 });
      await shot(page, `search-${w}-${theme}`);
      await axe(page, `search ${w} ${theme}`);
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
});
