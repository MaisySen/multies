import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ACTIONS, CONVERTERS, FORMATS, MAX_STEPS, actionsFor, catalogueStats, commonTargets, formatOf, parseRanges, planRoutes, renameTo, routeLine, routeTo,
} from "../src/shared/convert-routes";

const ALL = { features: ["convert_plus", "excel"], engine: true };

describe("R78 convert routes: the format table", () => {
  it("reads formats from names and types", () => {
    expect(formatOf("Photo.JPEG")).toBe("jpg");
    expect(formatOf("scan.heif")).toBe("heic");
    expect(formatOf("book.xlsx")).toBe("xlsx");
    expect(formatOf("noext", "image/png")).toBe("png");
    expect(formatOf("mystery.xyz")).toBeNull();
  });
  it("renames to the new extension", () => {
    expect(renameTo("holiday.photo.png", "jpg")).toBe("holiday.photo.jpg");
    expect(renameTo("report", "pdf", "-p1")).toBe("report-p1.pdf");
  });
  it("every converter joins two known formats and never loops on itself", () => {
    const ids = new Set(FORMATS.map((f) => f.id));
    for (const c of CONVERTERS) { expect(ids.has(c.from)).toBe(true); expect(ids.has(c.to)).toBe(true); expect(c.from).not.toBe(c.to); }
    expect(new Set(CONVERTERS.map((c) => c.id)).size).toBe(CONVERTERS.length);
  });
});

describe("R78 convert routes: the planner", () => {
  it("image pairs run on the device in one step", () => {
    for (const [a, b] of [["png", "jpg"], ["jpg", "webp"], ["webp", "avif"], ["gif", "png"], ["bmp", "pdf"], ["svg", "png"]] as const) {
      const r = routeTo(a, b)!;
      expect(r.local).toBe(true);
      expect(r.steps).toHaveLength(1);
      expect(r.engineRuns).toBe(0);
    }
  });
  it("sheets convert on the device, both ways", () => {
    for (const [a, b] of [["csv", "xlsx"], ["xlsx", "csv"], ["json", "csv"], ["tsv", "json"]] as const) expect(routeTo(a, b)!.local).toBe(true);
  });
  it("Word to PDF uses the engine; Word to JPG chains engine then device", () => {
    const pdf = routeTo("docx", "pdf", ALL)!;
    expect(pdf.local).toBe(false);
    expect(pdf.steps.map((s) => s.where)).toEqual(["engine"]);
    const jpg = routeTo("docx", "jpg", ALL)!;
    expect(jpg.steps.map((s) => s.where)).toEqual(["engine", "browser"]);
    expect(routeLine(jpg)).toMatch(/engine/);
  });
  it("prefers the device over the engine when both reach a target", () => {
    expect(routeTo("pdf", "png", ALL)!.local).toBe(true);
    expect(routeTo("csv", "xlsx", ALL)!.local).toBe(true);
  });
  it("never uses more than 3 steps or more than 1 engine run by default", () => {
    for (const f of FORMATS) for (const r of planRoutes(f.id, ALL)) {
      expect(r.steps.length).toBeLessThanOrEqual(MAX_STEPS);
      expect(r.engineRuns).toBeLessThanOrEqual(1);
      expect(new Set([r.from, ...r.steps.map((s) => s.to)]).size).toBe(r.steps.length + 1);
      for (let i = 1; i < r.steps.length; i++) expect(r.steps[i].from).toBe(r.steps[i - 1].to);
    }
  });
  it("respects maxSteps", () => {
    expect(planRoutes("docx", { ...ALL, maxSteps: 1 }).every((r) => r.steps.length === 1)).toBe(true);
  });
  it("with the engine off only device routes are planned", () => {
    expect(routeTo("docx", "pdf", { engine: false })).toBeNull();
    expect(planRoutes("png", { engine: false }).every((r) => r.local)).toBe(true);
  });
  it("engine converters behind a feature need it", () => {
    expect(routeTo("html", "pdf", { engine: true, features: [] })).toBeNull();
    expect(routeTo("html", "pdf", ALL)).not.toBeNull();
  });
  it("HEIC needs a browser that opens it", () => {
    const off = { engine: false, caps: { heicDecode: false, webpEncode: true, avifEncode: true } };
    expect(planRoutes("heic", off)).toHaveLength(0);
    expect(routeTo("heic", "jpg", { engine: false })!.local).toBe(true);
  });
  it("without a WEBP or AVIF encoder those targets drop out", () => {
    const caps = { heicDecode: true, webpEncode: false, avifEncode: false };
    expect(routeTo("png", "webp", { caps })).toBeNull();
    expect(routeTo("png", "avif", { caps })).toBeNull();
    expect(routeTo("png", "jpg", { caps })).not.toBeNull();
  });
});

describe("R78 convert routes: batches and actions", () => {
  it("common targets are those every file can reach", () => {
    const t = commonTargets(["png", "jpg", "webp"]).map((x) => x.to);
    expect(t).toContain("pdf");
    expect(t).toContain("avif");
    expect(t).not.toContain("xlsx");
    // A target equal to every source is not offered.
    expect(commonTargets(["png", "png"]).map((x) => x.to)).not.toContain("png");
    expect(commonTargets([])).toEqual([]);
  });
  it("a mixed batch is local only when every route is", () => {
    const mixed = commonTargets(["png", "docx"], ALL).find((x) => x.to === "pdf")!;
    expect(mixed.local).toBe(false);
    expect(mixed.engineRuns).toBe(1);
  });
  it("actions fit the files", () => {
    expect(actionsFor(["pdf", "pdf"]).map((a) => a.id)).toEqual(["merge", "split", "rotate", "numbers"]);
    expect(actionsFor(["pdf"]).map((a) => a.id)).toEqual(["split", "rotate", "numbers"]);
    expect(actionsFor(["png", "jpg"]).map((a) => a.id)).toEqual(["images-pdf"]);
    expect(actionsFor(["png", "pdf"])).toEqual([]);
    expect(ACTIONS.every((a) => a.label && a.line)).toBe(true);
  });
});

describe("R78 convert routes: page ranges", () => {
  it("reads ranges", () => {
    expect(parseRanges("1-3, 5, 8-", 10)).toEqual([[1, 3], [5, 5], [8, 10]]);
    expect(parseRanges("2 to 4", 5)).toEqual([[2, 4]]);
    expect(parseRanges("-2", 5)).toEqual([[1, 2]]);
  });
  it("refuses what does not read", () => {
    expect(parseRanges("", 5)).toBeNull();
    expect(parseRanges("0", 5)).toBeNull();
    expect(parseRanges("4-2", 5)).toBeNull();
    expect(parseRanges("9", 5)).toBeNull();
    expect(parseRanges("abc", 5)).toBeNull();
  });
});

describe("R78 convert routes: the catalogue", () => {
  it("counts formats and pairs", () => {
    const s = catalogueStats(ALL);
    expect(s.read).toBeGreaterThanOrEqual(20);
    expect(s.pairs).toBeGreaterThan(150);
    expect(s.localPairs).toBeGreaterThanOrEqual(60);
    const local = catalogueStats({ engine: false });
    expect(local.pairs).toBe(local.localPairs);
  });
});

describe("R78 Convert hub wiring", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  it("the heavy libraries load only from the lazy convert code", () => {
    for (const f of ["src/web/router.tsx", "src/web/pages/app/tools.tsx", "src/web/lib/convert/run.ts", "src/web/pages/app/tools-convert/convert-hub.tsx"]) {
      expect(read(f)).not.toMatch(/from ["'](pdf-lib|gifenc|write-excel-file|read-excel-file|@jsquash\/[a-z]+[^"']*)["']/);
    }
    expect(read("src/web/router.tsx")).toMatch(/lazyPage\(\(\) => import\("\.\/pages\/app\/tools-convert\/convert-hub"\)/);
  });
  it("no GPL codecs are used", () => {
    const pkg = JSON.parse(read("package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    for (const bad of ["libheif-js", "heic2any", "@ffmpeg/core", "@ffmpeg/ffmpeg", "ghostscript", "mupdf"]) expect(deps).not.toContain(bad);
  });
  it("the notices name the new libraries", () => {
    const n = read("THIRD_PARTY_NOTICES.md");
    for (const lib of ["pdf-lib", "gifenc", "write-excel-file", "read-excel-file", "@jsquash/avif", "@jsquash/webp", "pdfjs-dist"]) expect(n).toContain(lib);
  });
});
