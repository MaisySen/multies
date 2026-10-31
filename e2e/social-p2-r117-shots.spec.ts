import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R117: screenshots and axe for Social P2a (composer v2, planner week and list, library, approvals, drafts) at 1280
 * and 390 in light and dark, and Forest at both widths. Runs only with SHOTS_DIR set. axe must find nothing serious
 * or critical.
 */
const DIR = process.env.SHOTS_DIR;
test.skip(!DIR, "screenshots only with SHOTS_DIR");

let visitor = 0;
const ip = () => `10.188.${test.info().workerIndex % 200}.${++visitor}`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAUAAAAFACAIAAABC8jL9AAAI70lEQVR42u3dyZJURRQG4Ky2GZqp6WbjygdwAjcKKIMSqCig4IAQiIIoOD6MKKhbFwoKKASgIIqoCDLIIL6FIDiEYRihCwax6Zau7qLuPZnfF7VFqMzz33PyVtW1cdNryxIQU4clAAEGBBhoRmejYREgbIBTkmAwQgMVjNDWAAKP0BIMRmigkhFaCwYdGHAGBnRgKOUMDMQdoc3Q4AwMGKGBJriJBQIMVDNC+0Ew6MCAAAMCDMWcgS0ChA2wb2KBERqoZIS2BhB4hJZgMEIDlYzQWjDowIAzMKADQylnYCDuCG2GBmdgwAgNNMFNLBBgoJoR2g+CQQcGBBgQYCjmDGwRIGyAfRMLjNBAJSO0NYDAI7QEgxEaqGSE1oJBBwacgQEdGEo5AwNxR2gzNDgDA0ZooAluYoEAA9WM0H4QHN93S3uH9gfvfO+M1YsdYEtQQlCb/Q8KtgBTx8QO7e+VZwGm7qEd5D9JmOt2BrYItXDoqd4Q/87LYb7rfUmuRQeW4Gpz2xP9inPX+2ftoxFabsO/F0muYoS2Bu11MKPo9pvkqWLc1g4swe3J7ZKeUt7ppSvU1I2SbIQW3eBvXIyv9witBV8v3y6ZaBEuxHjaxp8thQ4surEXRIydgWtfqU+K7rVivEmMdWDRDb5QYtyqMzAtcEB6m4/xdBluRQcW4WFGt9siDOeqN33TOUvhDFxF/T0hui27Ak7/QIyN0G30jfS2+mp4tww3zyN1pNeqxj4Do8jqtbxacTMjtB8ED9rXj0+wCO2J8T0fnrcORmjptdpGaMWkmKpbdq1YB5Ze65/zGdgiDOirx1RPLTI8Y7M+POAILcEDpXe8RajPlXTG5l+sgxFaeu1IZiO0NbjKfrVS1wzP1If7jtAS3Ce9i6W31tfWmVtk2AgtvfYolxFaC77oy8XjLEKUDM/a8qt10IGl1345A2dQDYtUQ8gMz9paeh/WgaXX3sU+Axdtn/TGz/Dsgvtw0d/E2rdorADkcRWevfU3Z+DCdv1R6c3qWjz7oxIzXOgI/YX05nhFvre8DLuJBQKs/WJnqxmhC/tB8OePjFHoeWf4vo9/14GlF7sswIAAuzBjrwc6AxfxPvculN7iMjxnW/6H4Y6UGtm/pLdMexeOyb62nYEhcgfOvv/uXdhlmwtuwl15l7ffA5O7rCs88xH6swXab+nyroGcn4m1Z8Fo5cuFDM/d/ocODNQtwJme7rVf+o5jOda5DgyRO3CWDXjPfO2Xq5rw/NE5fozkcyQKklu1Z3gG3j1/lDqlX7vnj8qs2v3fCdGCQ3fgvHz6sPZLQRXiLjQEltUzsT55aKQdZTBN+MGdf+rAgAADAmx+psBq6Wz4HIki5VH5mTwTa9c87Zfm7Jo30jOxgGpHaGtAsVN0DiN0/Al657wRapEh2DlvhN8DA1WO0IZoSp6iY9d/+A6848FOVUix9eO50OjCOjBQSYBD34Tb8YD5mWFP0Q90eiYWGKOdgUF+mwqw/ELcFAS+ibX9/htUHoXXkrvQEFhWz8SCoU/RMYOgA0NgAgwC3Hbb5rr0oKI8Ewv+PQYHDLBvYsHlCBuhgXaO0NYAgvZf34WG0Ak2QkPsEVoLhgsN2E2sttg6R7GhrpyBIfgx2BkYYp+BgaANOOo3sf5WaoiwMzDEbsFGaAg8QruJBYEJMAQW9JlYbmJxfUboaHHQgcEIDQgw0OwZ2CLA5TNwtAB7JhZcGWEjNNC2EdoaQND+67vQEDrBRmiIPULHa8FL9ndunPmXzaPldeXHDIAzMDgA68CQ/RkYCNqAfRMLIkfYGRgCt2AjNAQeoaPexFr69QgFh4pyFxoCC/pMLGj1/BwzCDowBCbAIMBVWPbNSPtH4bXkmViQ4qbAN7EgxU2BMzBEPgM3Uor7Wn5glC1kmJYfGBU3Ar4LjfE5cge2fRBXyGdiXenpb0e/O+0PG8mQ6yd0AHRgiNyBnYFxANaBK52CDo5Wh5RZOX7Qj+4beoQ2QyPCgUfo0N/kuPRacahLMdKUFYe6Mqh8IzSab+gOnItnNGHKqxafA0NgnolFkfNzLmWfVQd+9rsxSpOi6sQIDQLs4ooKqegMbE8p6vSbWwduZPZaeXisMqVfKw+PzazanYEhcgdu5NeCU1qlCXOVVYfH5lfqfg9MOcffHDtwtpfbI5ow+ddD+GdiweC6b551nvNNrOeOjFO45F0JHSnLu1iXXs8dleHi03t0XMYV7mMkiNyBs27AqZHSak24YKuPjsu7vD0Ti9zvXuXdgVP2LbiRVh8br5BLbL/Hxmdf2x0F5Dc1Unpehgvz/LHxJRR2R1E7qqztdXYjNBBWWc/EeuH7Ce/ccd6uZ7/L5RR1R4G7q8TtrwDbY+ysAAPDOwOX+LbXHJ/w9hSH4dz2tMBi7ijjY+B+XmuOdyv6jNLbXWYZdxS/69jHyB24UWwLTqmR0loZDm7t8e6SC9gzsdLaE91vTT4nCUH3rvACdhf6Uh1g1wLyTKyLXjwxccPkn61DoP1SuDpw35qwCHYqWAfWgP9TGScnbrhdH677HilaHfh/6wO7E+cMTF8vnZy4Xh+u5b4o16tGaONI/7XSs/72s9ahVjtiEZyBm6mYUz3rb5PhuuyFQjVCN+3lUz1vynANdkGVDsRNrGtXj0Ww/nU+AzOoGtKKRbeWI3TDeDIor/zQ+8atZ6xD21ZbYRqhW19VFsE6G6HD15ZWLLo6sDrDqrbgDGwRhuLV073rbtGHW7meSnFoI7RlG3LNTUoprbvlJ0sx/GXEGViMRbfAEdoatMJrpye9LsNNrpjaa0UHtoqtqsgfJ6WUXr9ZjAe1UArPCC3GMaNL6zRuvGeKVYCgfA4MAgwIMCDAIMCAAAMCDAgwCDAgwIAAgwADAgwIMCDAIMCAAAMCDAgwCDAgwIAAgwADAgwIMCDAIMCAAAMCDAgwCDAgwIAAgwADAgwIMCDAIMCAAAMCDAIMCDAgwIAAgwADAgwIMCDAIMCAAAMCDAIMCDAgwIAAgwADAgwIMCDAIMCAAAMCDAIMCDAgwIAAgwADAgwIMJBS+geZ9nK+OKZeHAAAAABJRU5ErkJggg==";

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function seed(page: Page, origin: string) {
  const headers = { origin };
  const ids: Record<string, string> = {};
  for (const app of ["linkedin", "facebook", "instagram"]) {
    const r = await (await page.request.post("/api/apps/connect", { data: { app }, headers })).json() as { redirectUrl: string };
    const id = new URL(r.redirectUrl).searchParams.get("connected_account_id")!;
    await page.request.post(`/api/apps/accounts/${id}/confirm`, { headers });
    ids[app] = id;
  }
  const tz = "UTC";
  await page.request.put("/api/social/slots", { headers, data: { tz, slots: [1, 2, 3, 4, 5].flatMap((weekday) => [{ accountId: null, weekday, minute: 9 * 60 }, { accountId: null, weekday, minute: 15 * 60 }]) } });
  const day = (n: number, hh: number) => { const d = new Date(Date.now() + n * 86_400_000); d.setUTCHours(hh, 30, 0, 0); return d.toISOString(); };
  const post = (data: Record<string, unknown>) => page.request.post("/api/social/posts", { headers, data });
  await post({ text: "Spring launch on Friday. Doors open at 9.", targets: [{ accountId: ids.linkedin }, { accountId: ids.facebook, target: "pg_100", targetName: "Acme Studio" }], runAt: day(1, 11), campaign: "Spring launch" });
  await post({ text: "Behind the scenes at the studio this week.", format: "image", images: [{ contentType: "image/png", dataB64: PNG }], targets: [{ accountId: ids.instagram }, { accountId: ids.facebook, target: "pg_100", targetName: "Acme Studio" }], runAt: day(2, 13), campaign: "Spring launch" });
  await post({ text: "Weekend opening hours: 9 to 5 on Saturday.", targets: [{ accountId: ids.linkedin }], runAt: day(3, 10), mode: "submit" });
  await post({ text: "Draft: new range teaser, needs a photo.", targets: [{ accountId: ids.linkedin }], mode: "draft" });
  await page.request.post("/api/social/library", { headers, data: { kind: "caption", name: "Opening hours", body: "Open 9 to 5 on Saturday, closed Sunday.", campaign: "Evergreen" } });
  await page.request.post("/api/social/library", { headers, data: { kind: "hashtags", name: "Launch tags", body: "#springlaunch #smallbusiness #newrange", campaign: "Spring launch" } });
  await page.request.post("/api/social/library", { headers, data: { kind: "image", name: "Studio front", image: { contentType: "image/png", dataB64: PNG }, campaign: "Spring launch" } });
  return ids;
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}

async function axe(page: Page, tag: string) {
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${tag}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}

async function composer(page: Page) {
  await page.goto("/app/social/new");
  await expect(page.getByTestId("composer-v2")).toBeVisible();
  await page.getByTestId("pick-facebook").getByRole("checkbox").check();
  await page.getByTestId("pick-facebook").getByRole("combobox").selectOption({ label: "Acme Studio" }).catch(() => undefined);
  await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
  await page.getByTestId("social-text").fill("Spring launch on Friday. Doors open at 9 and the first 50 visitors get a tote. https://example.com/spring");
  await page.getByTestId("tab-linkedin").click();
  await page.getByTestId("social-text").fill("Our spring range lands Friday. Join us at the launch.");
  await page.getByTestId("tab-all").click();
}

test("social p2 screenshots and axe", async ({ page, context, baseURL }) => {
  test.setTimeout(420_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/social/library");
  await expect(page.getByTestId("social-library")).toBeVisible();
  await shot(page, "e00-library-empty-1280-light");
  await seed(page, origin);
  const bad: string[] = [];
  const pages: [string, string, () => Promise<void>][] = [
    ["composer", "/app/social/new", () => composer(page)],
    ["planner-week", "/app/social?view=week", async () => { await page.goto("/app/social?view=week"); await expect(page.getByTestId("planner-v2")).toBeVisible(); }],
    ["planner-month", "/app/social?view=month", async () => { await page.goto("/app/social?view=month"); await expect(page.getByTestId("month-grid")).toBeVisible(); }],
    ["planner-list", "/app/social?view=list", async () => { await page.goto("/app/social?view=list"); await expect(page.getByTestId("list-view")).toBeVisible(); }],
    ["library", "/app/social/library", async () => { await page.goto("/app/social/library"); await expect(page.getByTestId("library-item").first()).toBeVisible(); }],
    ["approvals", "/app/approvals", async () => { await page.goto("/app/approvals"); await expect(page.getByTestId("social-approval").first()).toBeVisible(); }],
    ["drafts", "/app/social/posts?status=drafts", async () => { await page.goto("/app/social/posts?status=drafts"); await expect(page.getByTestId("social-post").first()).toBeVisible(); }],
  ];
  let n = 10;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const [name, , go] of pages) {
        await go();
        await shot(page, `e${n++}-${name}-${w}-${scheme}`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} ${w} scrolls sideways`).toBe(true);
        bad.push(...await axe(page, `${scheme} ${w} ${name}`));
      }
    }
  }
  // Dialogs: time slots, preview sheet on a phone, library add.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/social");
  await page.getByTestId("open-slots").click();
  await expect(page.getByTestId("slots-dialog")).toBeVisible();
  await shot(page, "e80-slots-dialog-1280-light");
  await page.keyboard.press("Escape");
  await composer(page);
  await page.getByTestId("more-options").click();
  await page.getByTestId("when-later").click();
  await page.getByTestId("composer-checks").scrollIntoViewIfNeeded();
  await shot(page, "e81-composer-options-1280-light");
  await page.setViewportSize({ width: 390, height: 844 });
  await composer(page);
  await page.getByTestId("open-preview").click();
  await shot(page, "e82-preview-sheet-390-light");
  await page.keyboard.press("Escape");

  // Forest.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  for (const [w, h] of [[1280, 860], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, , go] of pages.filter(([nm]) => ["composer", "planner-week", "library", "approvals"].includes(nm))) {
      await go();
      await shot(page, `e9${n++ % 10}-${name}-${w}-forest`);
      bad.push(...await axe(page, `forest ${w} ${name}`));
    }
  }
  expect(bad).toEqual([]);
});
