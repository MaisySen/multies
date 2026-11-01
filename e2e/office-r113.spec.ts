import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { readDocx, writeDocx } from "../src/shared/office-r113/docx";
import { readXlsx, writeXlsx } from "../src/shared/office-r113/xlsx";
import { parseInput } from "../src/shared/office-r113/sheet";

/**
 * R113 Office files in the browser (OFFICE_EDIT_R113=on) in a demo workspace (made up files only). Flows: open a DOCX
 * from Files, edit, save as a new version, restore the old one; XLSX formula edit and save; CSV edit and save; PPTX
 * slides (the outline when the engine is not available); a newer version saved meanwhile; view only; too big.
 * Axe at 1280 and 390, light and dark, plus Forest. SHOTS_DIR writes r113-*.png.
 */
const SHOTS = process.env.SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

test.describe.configure({ mode: "serial" });
let page: Page;
const ids: Record<string, string> = {};

async function settle(p: Page) {
  await p.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  await p.waitForTimeout(250);
}
async function noSeriousAxe(p: Page) {
  await p.mouse.move(0, 0); await settle(p);
  const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
async function check(p: Page, name: string) {
  for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
    await p.setViewportSize({ width: w, height: h });
    for (const scheme of ["light", "dark"] as const) {
      await p.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await noSeriousAxe(p);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} ${vp} horizontal scroll`).toBeLessThanOrEqual(1);
      if (SHOTS) await p.screenshot({ path: join(SHOTS, `r113-${name}-${vp}-${scheme}.png`) });
    }
  }
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
}
async function put(name: string, body: Uint8Array, type: string) {
  const origin = new URL(page.url()).origin;
  const r = await page.request.put(`/api/drive/upload?space=team&name=${encodeURIComponent(name)}`, { headers: { origin, "x-multies-upload": "1", "content-type": type }, data: Buffer.from(body) });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).item.id as string;
}
async function detail(id: string) { return (await page.request.get(`/api/drive/items/${id}`)).json(); }
async function bytes(id: string) { return new Uint8Array(await (await page.request.get(`/api/drive/items/${id}/content`)).body()); }
const docOf = (t: string) => writeDocx({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Quarterly plan" }] }, { type: "paragraph", content: [{ type: "text", text: t }] }, { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Hire two people" }] }] }] }] });
function pptx() {
  const slide = (title: string, body: string) => strToU8(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  return zipSync({ "ppt/presentation.xml": strToU8(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`),
    "ppt/_rels/presentation.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="slides/slide1.xml" Type="s"/><Relationship Id="rId3" Target="slides/slide2.xml" Type="s"/></Relationships>`),
    "ppt/slides/slide1.xml": slide("Welcome to the launch", "Made up deck"), "ppt/slides/slide2.xml": slide("Next steps", "Ship it") });
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  ids.docx = await put("Quarterly plan.docx", docOf("Original words"), DOCX);
  const wb = { sheets: [{ name: "Budget", cells: new Map([["A1", parseInput("2")], ["A2", parseInput("3")], ["B1", parseInput("Pens")]]), rowCount: 50, colCount: 12 }] };
  ids.xlsx = await put("Budget.xlsx", writeXlsx(wb), XLSX);
  ids.csv = await put("Contacts list.csv", new TextEncoder().encode("name,city\nAva,Sydney\nNoah,Perth\n"), "text/csv");
  ids.pptx = await put("Launch deck.pptx", pptx(), PPTX);
});
test.afterAll(async () => { await page.close(); });

test("1. DOCX: open from Files, edit, save as a new version, restore the old one", async () => {
  await page.goto("/app/files?view=team");
  const row = page.getByTestId("drive-row").filter({ hasText: "Quarterly plan" }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole("button", { name: /Quarterly plan/ }).first().click();
  await page.getByTestId("drive-open-editor").click();
  await expect(page).toHaveURL(/\/app\/files\/edit\//);
  const doc = page.getByRole("textbox", { name: "Document" });
  await expect(doc).toContainText("Original words", { timeout: 20_000 });
  await expect(page.getByText("Some formatting may look different. The original stays in Versions.")).toBeVisible();
  await check(page, "docx");
  await doc.getByText("Original words").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" and new ones");
  await page.getByRole("button", { name: "Bold" }).click();
  await page.keyboard.type(" bold");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved as version 2")).toBeVisible();
  const d = await detail(ids.docx);
  expect(d.item.versions).toBe(2);
  expect(d.versions[0].note).toBe("Saved in the editor");
  const saved = readDocx(await bytes(ids.docx)).doc.content!;
  expect(JSON.stringify(saved)).toContain("Original words and new ones");
  expect(JSON.stringify(saved)).toContain('"bold"');
  expect(saved[2].type).toBe("bulletList");
  // Restore the original from Versions: a third version with the old words.
  await page.goto("/app/files?view=team");
  await page.getByTestId("drive-row").filter({ hasText: "Quarterly plan" }).first().getByRole("button", { name: /Quarterly plan/ }).first().click();
  await page.getByTestId("drive-preview").getByRole("tab", { name: /Versions/ }).or(page.getByTestId("drive-preview").getByRole("button", { name: /^Versions/ })).first().click();
  await page.getByTestId("drive-preview").getByRole("button", { name: "Restore" }).first().click();
  await expect.poll(async () => (await detail(ids.docx)).item.versions).toBe(3);
  expect(JSON.stringify(readDocx(await bytes(ids.docx)).doc)).not.toContain("new ones");
});

test("2. XLSX: edit a formula and save", async () => {
  await page.goto(`/app/files/edit/${ids.xlsx}`);
  const grid = page.getByRole("grid", { name: "Budget sheet" });
  await expect(grid).toBeVisible({ timeout: 20_000 });
  await grid.focus();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
  await page.keyboard.type("=SUM(A1:A2)*2");
  await page.keyboard.press("Enter");
  await expect(grid.getByRole("gridcell").filter({ hasText: /^10$/ })).toHaveCount(1);
  await page.keyboard.press("ArrowUp");
  await expect(page.getByLabel("Cell contents")).toHaveValue("=SUM(A1:A2)*2");
  await page.keyboard.type("=1/0"); await page.keyboard.press("Enter");
  await expect(grid.getByRole("gridcell").filter({ hasText: "#DIV/0!" })).toHaveCount(1);
  await page.keyboard.press("ArrowUp"); await page.keyboard.type("=SUM(A1:A2)*2"); await page.keyboard.press("Enter");
  await check(page, "xlsx");
  await page.keyboard.press("Control+s");
  await expect(page.getByText("Saved as version 2")).toBeVisible();
  const wb = readXlsx(await bytes(ids.xlsx)).wb;
  expect(wb.sheets[0].cells.get("A3")).toMatchObject({ f: "SUM(A1:A2)*2", v: 10 });
});

test("3. CSV: edit a cell and save values", async () => {
  await page.goto(`/app/files/edit/${ids.csv}`);
  const grid = page.getByRole("grid");
  await expect(grid.getByRole("gridcell").filter({ hasText: "Sydney" })).toBeVisible({ timeout: 20_000 });
  await grid.getByRole("gridcell").filter({ hasText: "Sydney" }).click();
  await page.keyboard.type("Hobart"); await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved as version 2")).toBeVisible();
  expect(new TextDecoder().decode(await bytes(ids.csv))).toBe("name,city\r\nAva,Hobart\r\nNoah,Perth\r\n");
});

test("4. PPTX: slides open (text outline when slides cannot be drawn)", async () => {
  await page.goto(`/app/files/edit/${ids.pptx}`);
  await expect(page.getByText("Slide 1 of 2")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Welcome to the launch" }).or(page.getByRole("img", { name: "Slide 1" }))).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Slide 2 of 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await check(page, "pptx");
});

test("5. a newer version saved meanwhile asks before saving", async () => {
  await page.goto(`/app/files/edit/${ids.docx}`);
  const doc = page.getByRole("textbox", { name: "Document" });
  await expect(doc).toContainText("Original words", { timeout: 20_000 });
  await put("ignored.txt", new Uint8Array([1]), "text/plain");
  const origin = new URL(page.url()).origin;
  const r = await page.request.put(`/api/drive/items/${ids.docx}/content`, { headers: { origin, "x-multies-upload": "1", "content-type": DOCX }, data: Buffer.from(docOf("Someone else")) });
  expect(r.ok()).toBe(true);
  await doc.getByText("Original words").click();
  await page.keyboard.type(" mine");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Someone saved a newer version" })).toBeVisible();
  const before = (await detail(ids.docx)).item.versions;
  await page.getByRole("button", { name: "Save mine as a new version" }).click();
  await expect(page.getByText(`Saved as version ${before + 1}`)).toBeVisible();
});

test("6. view only and too big", async () => {
  await page.route(`**/api/drive/items/${ids.xlsx}`, async (route) => {
    const res = await route.fetch(); const body = await res.json();
    body.item.canEdit = false;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`/app/files/edit/${ids.xlsx}`);
  await expect(page.getByText("View only").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Cell contents")).toHaveAttribute("readonly", "");
  await page.unroute(`**/api/drive/items/${ids.xlsx}`);
  await page.route(`**/api/drive/items/${ids.csv}`, async (route) => {
    const res = await route.fetch(); const body = await res.json();
    body.item.sizeBytes = 30 * 1024 * 1024;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`/app/files/edit/${ids.csv}`);
  await expect(page.getByText("This file is too big to open here")).toBeVisible({ timeout: 20_000 });
  await check(page, "toobig");
  await page.unroute(`**/api/drive/items/${ids.csv}`);
});

test("7. Forest theme shots", async () => {
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await expect(page.getByRole("button", { name: "Forest", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const k of ["docx", "xlsx", "pptx"]) {
    await page.goto(`/app/files/edit/${ids[k]}`);
    await expect(page.getByRole("textbox", { name: "Document" }).or(page.getByRole("grid")).or(page.getByText(/Slide 1 of/)).first()).toBeVisible({ timeout: 30_000 });
    for (const [vp, w, h] of [["1280", 1280, 900], ["390", 390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await noSeriousAxe(page);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `r113-${k}-${vp}-forest.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});
