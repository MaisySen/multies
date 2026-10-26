
const { chromium } = require("playwright");
const phase = process.argv[2]; const base = process.env.BASE || "http://localhost:8979"; const out = "/home/user/tab/files/multies-r39/";
const fs = require("fs"); fs.mkdirSync(out, { recursive: true });
const BODY = { type: "doc", content: [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Launch plan" }] },
  { type: "paragraph", content: [{ type: "text", text: "We ship the new pricing page on Monday and send the customer newsletter on Tuesday." }] },
  { type: "bulletList", content: ["Final copy from Priya", "Design review on Thursday", "Press kit ready"].map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
] };
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "10.39.7." + Math.floor(Math.random() * 200) } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto(base + "/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await page.waitForURL(/\/app/, { timeout: 30000 });
  const headers = { origin: base };
  const doc = (await (await page.request.post(base + "/api/docs", { headers, data: { title: "Launch plan", content: BODY } })).json()).doc;
  if (phase === "after") {
    // Two editing sessions by different people: a member, then an agent key style rewrite through the API.
    await page.request.post(base + `/api/docs/${doc.id}/versions`, { headers, data: { name: "First draft" } });
    let v = doc.version;
    const edit = async (content) => { const r = await (await page.request.patch(base + `/api/docs/${doc.id}`, { headers, data: { content, version: v } })).json(); v = r.doc.version; };
    const c2 = JSON.parse(JSON.stringify(BODY)); c2.content[1].content[0].text = "We ship the new pricing page on Wednesday and send the customer newsletter on Thursday.";
    c2.content.push({ type: "paragraph", content: [{ type: "text", text: "Owner: Priya. Budget agreed with finance." }] });
    await edit(c2);
    await page.request.post(base + `/api/docs/${doc.id}/versions`, { headers, data: { name: "Dates moved" } });
    const c3 = JSON.parse(JSON.stringify(c2)); c3.content.splice(2, 1);
    await edit(c3);
  }
  for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "phone"]]) for (const scheme of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(base + `/app/docs/${doc.id}`);
    await page.waitForSelector(".ProseMirror", { timeout: 20000 });
    await page.waitForTimeout(1200);
    if (phase === "before") { await page.screenshot({ path: `${out}page-history-before-doc-${tag}-${scheme}.png` }); continue; }
    await page.getByRole("button", { name: "Page history" }).click();
    await page.waitForSelector("[data-testid=doc-history-panel] [data-testid=doc-version-row]", { timeout: 15000 });
    await page.locator("[data-testid=doc-version-row]").nth(0).click();
    await page.waitForSelector("[data-testid=doc-version-diff]", { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}page-history-after-compare-${tag}-${scheme}.png` });
    await page.keyboard.press("Escape");
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
