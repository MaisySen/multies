import { test, expect, type Page } from "@playwright/test";

/**
 * QUAL1: MapLibre 6 loads its worker from a separate file that it looks for next to its own module, which a bundled
 * chunk is not; map-view-r115.tsx points it at the copy Vite puts in the build. This checks that a real map page
 * fetches that worker from our own origin as JavaScript, draws the visit line (a GeoJSON source, which needs the
 * worker) and logs no error. Needs MAPS_R115=on MAPS_GEO_MOCK=1 on the e2e server, like e2e/maps-r115.spec.ts.
 */
let visitor = 0;
const ip = () => `10.197.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.route("https://tiles.openfreemap.org/**", (r) => r.fulfill({ json: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e9eef2" } }] } }));
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

test("the map loads its worker from our own origin and draws a visit line without errors", async ({ page }) => {
  test.skip((await (await page.request.get("/api/config")).json()).maps !== true, "MAPS_R115 is off on this server");
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await demo(page);
  const people = ((await (await page.request.get("/api/contacts")).json()) as { contacts: { id: string; name: string; email: string }[] }).contacts.slice(0, 2);
  expect(people.length).toBe(2);
  for (const [i, p] of people.entries()) {
    const r = await page.request.put("/api/maps/places", { data: { entityType: "contact", entityId: p.id, address: `${i + 1} Worker Street, Sydney NSW`, lat: -33.87, lon: 151.1 + i / 10 } });
    expect(r.status()).toBe(200);
  }
  const worker = page.waitForResponse((r) => /maplibre-gl-worker[^/]*\.m?js(\?|$)/.test(r.url()), { timeout: 20_000 });
  await page.goto("/app/contacts?tab=visits");
  await expect(page.getByText("Who are you visiting?")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("visit-add").click();
  const dialog = page.getByRole("dialog", { name: "Add stops" });
  for (const p of people) await dialog.getByRole("checkbox", { name: new RegExp(p.name || p.email) }).check();
  await dialog.getByTestId("visit-add-confirm").click();
  await expect(page.getByTestId("visit-stops").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("map")).toBeVisible();
  const res = await worker;
  expect(res.status()).toBe(200);
  expect(new URL(res.url()).origin).toBe(new URL(page.url()).origin);
  expect(res.headers()["content-type"] ?? "").toMatch(/javascript/);
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.waitForTimeout(500); // let the worker answer the line source
  await expect(page.getByText("The map could not load")).toHaveCount(0);
  expect(errors.filter((e) => /worker|maplibre|Failed to fetch/i.test(e))).toEqual([]);
});
