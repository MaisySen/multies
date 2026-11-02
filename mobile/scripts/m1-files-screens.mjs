// M1 files: the Files screens (Team files, a folder, select mode, add sheet, move sheet, Trash, Brand library, file detail,
// brand detail, image preview) on the web build with the sample workspace (no server, no network), light and dark at 390,
// with layout checks (no sideways scroll) and axe.
// Usage: node scripts/m1-files-screens.mjs <web-export-dir> <out-dir> [--only=390-light]
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const dir = process.argv[2] ?? "dist-web";
const out = process.argv[3] ?? "screens";
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let f = join(dir, p);
  if (!existsSync(f) || statSync(f).isDirectory()) f = existsSync(`${f}.html`) ? `${f}.html` : existsSync(join(f, "index.html")) ? join(f, "index.html") : join(dir, "index.html");
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const problems = [];
const browser = await chromium.launch();
try {
  for (const width of [390]) for (const scheme of ["light", "dark"]) {
    const tag = `${width}-${scheme}`;
    if (only && tag !== only) continue;
    const ctx = await browser.newContext({ viewport: { width, height: width === 375 ? 812 : 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-AU", timezoneId: "Australia/Sydney", colorScheme: scheme });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const tid = (id) => page.getByTestId(id).filter({ visible: true }).first();
    const shot = async (name) => {
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${out}/${name}-${tag}.png` });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) problems.push(`${name} ${tag}: scrolls sideways`);
      if (width !== 390) return;
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      const serious = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      if (serious.length) problems.push(`${name} ${tag}: axe ${serious.map((v) => `${v.id}(${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.html.slice(0, 90)).join(" | ")}`).join("; ")}`);
    };
    const step = async (name, fn) => { try { await fn(); } catch (e) { problems.push(`${name} ${tag}: ${String(e).split("\n")[0].slice(0, 200)}`); } };
    await page.goto(base);
    await page.waitForLoadState("networkidle");
    if (await page.getByTestId("sample").first().isVisible().catch(() => false)) await tid("sample").click();
    await page.waitForTimeout(2500);
    const go = async (path, id) => { await page.goto(`${base}${path}`); await tid(id).waitFor(); };
    await step("team", async () => { await go("/files?view=team", "files-row-0"); await page.getByText("Price list 2026.pdf").first().waitFor(); await shot("01-team"); });
    await step("folder", async () => { await go("/files?view=team&folder=drv-clients", "files-crumbs"); await page.getByText("Acme proposal.docx").first().waitFor(); await shot("02-folder"); });
    await step("select", async () => {
      await go("/files?view=team", "files-row-0");
      await tid("files-select").click(); await tid("files-row-2").click(); await tid("files-row-3").click();
      await tid("files-select-bar").waitFor(); await shot("03-select");
      await step("move", async () => { await tid("files-move").click(); await tid("files-move-sheet").waitFor(); await shot("04-move-sheet"); });
    });
    await step("add", async () => { await go("/files?view=mine", "files-add"); await tid("files-add").click(); await tid("files-add-sheet").waitFor(); await shot("05-add-sheet"); });
    await step("new folder", async () => { await go("/files?view=team", "files-add"); await tid("files-add").click(); await page.getByText("New folder").first().click(); await tid("files-new-folder").waitFor(); await shot("06-new-folder"); });
    await step("trash", async () => { await go("/files?view=trash", "files-row-0"); await shot("07-trash"); });
    await step("brand", async () => { await go("/files?view=brand", "files-row-0"); await tid("files-tags").waitFor(); await shot("08-brand"); });
    await step("starred", async () => { await go("/files?view=starred", "files-row-0"); await shot("09-starred"); });
    await step("detail", async () => { await go("/files-item/drv-price", "file-detail"); await shot("10-detail"); });
    await step("detail brand", async () => { await go("/files-item/drv-logo", "file-detail"); await shot("11-detail-brand"); });
    await step("preview", async () => { await go("/files-preview/drv-photo?name=Office%20opening.jpg", "file-preview"); await shot("12-preview"); });
    if (errors.length) problems.push(`${tag}: page errors ${errors.slice(0, 2).join(" | ").slice(0, 300)}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `PROBLEMS ${problems.length}\n${problems.join("\n")}` : "OK no problems");
