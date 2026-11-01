import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { shieldAnswers } from "./support/shield"; // R92

/**
 * R115 (older bug from R99's report): the Bookings list on /app/scheduling read only the first page of bookings.
 * With more than one page it now shows Load more and loads the rest, on a phone too.
 */
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

test("bookings list loads every page with Load more, at 390 too", async ({ page, request }) => {
  test.setTimeout(240_000);
  await demo(page);
  const slug = `paging-${Date.now().toString(36)}`;
  const week = [["08:00", "18:00"]];
  const r = await page.request.put("/api/scheduling/page", { data: { slug, title: "Quick calls", timezone: "Australia/Sydney", hours: { mon: week, tue: week, wed: week, thu: week, fri: week }, slotMin: 15, minNoticeMin: 0, maxDaysAhead: 30 } });
  expect(r.status()).toBe(200);
  const before = ((await (await page.request.get("/api/scheduling/bookings?upcoming=1&limit=500")).json()) as { bookings: unknown[] }).bookings.length;
  const pub = (await (await request.get(`/api/book/${slug}?days=21`, { headers: { "x-forwarded-for": ip() } })).json()) as { slots: string[] };
  expect(pub.slots.length).toBeGreaterThan(60);
  const want = 55;
  // R92: with Booking plus on, every public booking carries a spam shield answer (each works once).
  const answers = await shieldAnswers(request, "book", 70, { "x-forwarded-for": ip() });
  let made = 0;
  for (const startsAt of pub.slots) {
    if (made >= want) break;
    const b = await request.post(`/api/book/${slug}`, { headers: { "x-forwarded-for": ip() }, data: { startsAt, name: `Caller ${made + 1}`, email: `caller${made + 1}@example.com`, timezone: "Australia/Sydney", shield: answers.shift() } });
    if (b.status() === 201) made++;
  }
  expect(made).toBe(want);
  const total = before + want;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/scheduling");
  const list = page.locator('section[aria-labelledby="bk-upcoming"]');
  const rows = list.getByRole("button", { name: /^Cancel booking with / });
  await expect(rows).toHaveCount(50, { timeout: 20_000 });
  const more = list.getByTestId("bookings-more");
  await expect(more).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id)).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  while (await more.isVisible()) {
    await more.click();
    await page.waitForTimeout(300);
  }
  await expect(rows).toHaveCount(total);
  await expect(list).toContainText(`Caller ${want}`);
  await expect(more).toHaveCount(0);
});
