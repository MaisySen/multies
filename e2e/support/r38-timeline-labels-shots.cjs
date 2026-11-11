
const { chromium } = require("playwright");
const phase = process.argv[2]; const base = process.env.BASE || "http://localhost:8976"; const out = (process.env.SHOTS_ROOT || "/home/user/tab/files") + "/multies-r38/";
const fs = require("fs"); fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "10.37.9." + Math.floor(Math.random()*200) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(base + "/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await page.waitForURL(/\/app/, { timeout: 30000 });
  const headers = { origin: base };
  const project = (await (await page.request.post(base + "/api/projects", { headers, data: { name: "Website launch", key: "WEB" } })).json()).project;
  const d = (n) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const mk = async (title, s, e) => (await (await page.request.post(base + "/api/tasks", { headers, data: { projectId: project.id, title, start: d(s), due: d(e) } })).json()).task;
  const a = await mk("Write the copy", 0, 1), bb = await mk("Design the pages", 2, 3), c = await mk("Build the site", 4, 12), e = await mk("Launch review", 13, 13), f = await mk("Press kit for the launch week", 2, 6);
  await mk("Send Priya the retention numbers from the quarterly review", 1, 2);
  const link = (x, y) => page.request.post(base + `/api/tasks/${y.id}/dependencies`, { headers, data: { blockedBy: x.id } });
  await link(a, bb); await link(bb, c); await link(c, e); await link(a, f);
    for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(base + `/app/tasks?view=timeline&project=${project.id}`);
    await page.waitForSelector("[data-testid=task-timeline]", { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}timeline-labels-${phase}-${tag}-${scheme}.png` });
    if (tag === "desktop" && scheme === "light") {
      const pill = page.getByTestId("schedule-clash-pill");
      if (await pill.count()) { await pill.click(); await page.waitForTimeout(600); await page.screenshot({ path: `${out}timeline-labels-${phase}-clash-sheet-light.png` }); await page.keyboard.press("Escape"); }
    }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
