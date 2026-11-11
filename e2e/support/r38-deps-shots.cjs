
const { chromium } = require("playwright");
const phase = process.argv[2]; const base = "http://localhost:8972"; const out = (process.env.SHOTS_ROOT || "/home/user/tab/files") + "/multies-r38/";
const fs = require("fs"); fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "10.38.9." + Math.floor(Math.random()*200) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(base + "/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await page.waitForURL(/\/app/, { timeout: 30000 });
  const headers = { origin: base };
  const project = (await (await page.request.post(base + "/api/projects", { headers, data: { name: "Website launch", key: "WEB" } })).json()).project;
  const d = (n) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const mk = async (title, s, e) => (await (await page.request.post(base + "/api/tasks", { headers, data: { projectId: project.id, title, start: d(s), due: d(e) } })).json()).task;
  const a = await mk("Write the copy", -2, 2), bb = await mk("Design the pages", 3, 7), c = await mk("Build the site", 6, 11), e = await mk("Launch review", 14, 14), f = await mk("Press kit", 4, 6);
  const link = (x, y, lagDays) => page.request.post(base + `/api/tasks/${y.id}/dependencies`, { headers, data: { blockedBy: x.id, ...(lagDays !== undefined ? { lagDays } : {}) } });
  await link(a, bb); await link(bb, c); await link(c, e, 2); await link(a, f);
  const shot = async (name) => { await page.waitForTimeout(900); await page.screenshot({ path: `${out}${name}.png` }); };
  for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(base + `/app/tasks?view=timeline&project=${project.id}`);
    await page.waitForSelector("[data-testid=task-timeline]", { timeout: 20000 });
    await shot(`deps-${phase}-timeline-${tag}-${scheme}`);
    if (tag === "desktop") {
      const bar = page.locator(`.wx-bar[data-task-id=':${a.id}']`);
      const bx = await bar.boundingBox();
      if (bx) {
        await page.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2); await page.mouse.down();
        for (let i = 1; i <= 6; i++) await page.mouse.move(bx.x + bx.width / 2 + i * 18, bx.y + bx.height / 2);
        await page.mouse.up(); await page.waitForTimeout(1500);
        console.log("MOVE SHEET", tag, scheme, await page.getByTestId("schedule-move-list").count());
        await shot(`deps-${phase}-move-sheet-${tag}-${scheme}`);
        await page.keyboard.press("Escape"); await page.waitForTimeout(700);
      }
    }
    await page.goto(base + `/app/tasks?view=list&project=${project.id}`);
    await page.waitForTimeout(1200);
    await shot(`deps-${phase}-list-row-${tag}-${scheme}`);
    await page.goto(base + `/app/tasks?view=board&project=${project.id}`);
    await page.waitForTimeout(1200);
    await shot(`deps-${phase}-board-card-${tag}-${scheme}`);
    if (phase === "after") {
      await page.goto(base + `/app/tasks?view=list&project=${project.id}&task=${e.id}`);
      await page.waitForTimeout(1500);
      await page.getByTestId("dependencies").scrollIntoViewIfNeeded().catch(() => {});
      await shot(`deps-after-task-panel-gap-${tag}-${scheme}`);
      if (tag === "desktop" && scheme === "light") {
        await page.keyboard.press("Escape");
        await page.goto(base + `/app/tasks?view=list&project=${project.id}`);
        await page.waitForTimeout(1000);
        const bdg = page.locator(`[data-task-id="${c.id}"] [data-testid=clash-badge] [tabindex]`);
        if (await bdg.count()) { await bdg.hover(); await shot(`deps-after-list-badge-tooltip-desktop-light`); }
      }
    }
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
