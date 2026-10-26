
const { chromium } = require("playwright");
const phase = process.argv[2]; const base = "http://localhost:8970"; const out = "/home/user/tab/files/multies-r37/";
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
  const a = await mk("Write the copy", 0, 3), bb = await mk("Design the pages", 4, 8), c = await mk("Build the site", 7, 12), e = await mk("Launch review", 13, 13), f = await mk("Press kit", 2, 6);
  const link = (x, y) => page.request.post(base + `/api/tasks/${y.id}/dependencies`, { headers, data: { blockedBy: x.id } });
  await link(a, bb); await link(bb, c); await link(c, e); await link(a, f);
  fs.writeFileSync("/tmp/r37f-shot-ids.json", JSON.stringify({ project: project.id, a: a.id, b: bb.id, c: c.id }));
  for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(base + `/app/tasks?view=timeline&project=${project.id}`);
    await page.waitForSelector("[data-testid=task-timeline]", { timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}timeline-${phase}-${tag}-${scheme}.png` });
    if (phase === "after" && tag === "desktop" && scheme === "light") {
      const pill = page.getByTestId("schedule-clash-pill");
      if (await pill.count()) { await pill.click(); await page.waitForTimeout(600); await page.screenshot({ path: `${out}timeline-after-clashes-sheet-light.png` }); await page.keyboard.press("Escape"); }
      // Drag "Write the copy" 3 days later: the sheet lists the tasks that wait on it.
      const bar = page.locator(`.wx-bar[data-task-id=':${a.id}']`);
      const bx = await bar.boundingBox();
      if (bx) {
        await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await page.mouse.down();
        for (let i = 1; i <= 6; i++) await page.mouse.move(bx.x + bx.width / 2 + i * 18, bx.y + bx.height / 2);
        await page.mouse.up(); await page.waitForTimeout(1500);
        await page.screenshot({ path: `${out}timeline-after-move-sheet-light.png` });
        console.log("MOVE SHEET", await page.getByTestId("schedule-move-list").count());
        await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      }
    }
    if (phase === "after" && tag === "desktop" && scheme === "dark") {
      const pill = page.getByTestId("schedule-clash-pill");
      if (await pill.count()) { await pill.click(); await page.waitForTimeout(600); await page.screenshot({ path: `${out}timeline-after-clashes-sheet-dark.png` }); await page.keyboard.press("Escape"); }
    }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
