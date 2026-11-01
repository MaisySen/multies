import { test, expect, type Page } from "@playwright/test";

/**
 * LK1: long searches no longer answer 500 (D1 refuses LIKE patterns over 50 bytes). Demo workspace, made up items.
 * Files and Contacts searched with 70+ character, Nepali and emoji queries through the running app's own API.
 */
async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  return origin;
}

test("Files: a 70+ character search finds the file", async ({ page }) => {
  const origin = await demo(page);
  const name = "Quarterly board pack for the harbour expansion project final signed copy v3.txt";
  const up = await page.request.put(`/api/drive/upload?${new URLSearchParams({ space: "team", name })}`, { headers: { origin, "content-type": "text/plain", "x-multies-upload": "1" }, data: Buffer.from("hello") });
  expect(up.ok(), await up.text()).toBe(true);
  for (const q of [name.slice(0, -4), "रामबहादुर श्रेष्ठ काठमाडौं 🏔️🎉 ".repeat(3)]) {
    const r = await page.request.get(`/api/drive/list?view=team&q=${encodeURIComponent(q)}`);
    expect(r.status(), q).toBe(200);
    expect((await r.text()).includes(name)).toBe(q.startsWith("Quarterly"));
  }
});

test("Contacts: long, Nepali and emoji searches find the person", async ({ page }) => {
  const origin = await demo(page);
  const people = [["Ravindra Bahadur Shrestha Thapa Magar of the Kathmandu Valley Office", "ravindra@valley-office.com.np"], ["राम बहादुर श्रेष्ठ काठमाडौं उपत्यका 🏔️", "ram@valley-office.com.np"]];
  for (const [name, email] of people) expect((await page.request.post("/api/contacts", { headers: { origin }, data: { name, email } })).ok()).toBe(true);
  for (const [name] of people) {
    const r = await page.request.get(`/api/contacts?q=${encodeURIComponent(name!)}`);
    expect(r.status()).toBe(200);
    expect((await r.json()).contacts.map((c: { name: string }) => c.name)).toEqual([name]);
  }
  const co = await page.request.get(`/api/companies?q=${encodeURIComponent("valley-office.com.np ".repeat(4))}`);
  expect(co.status()).toBe(200);
  const s = await page.request.get(`/api/search?q=${encodeURIComponent(people[0]![0]!)}`);
  expect(s.status()).toBe(200);
});
