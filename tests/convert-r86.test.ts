/**
 * R86 Tools round B: the Convert hub's new formats (video, audio, e-books, archives), HEIC on the engine outside
 * Safari, compress and OCR actions, archive packing on the device, and the catalogue's new engine tools.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIONS, ALL_CAPS, actionEngineRuns, actionsFor, commonTargets, formatOf, planRoutes, renameTo, routeTo,
} from "../src/shared/convert-routes";
import { EXT_TYPES, TOOLS, catalogueFor, emptyResult, extForType, resultExt, toolDef } from "../src/shared/tools";
import { safeArchivePath, tarFiles } from "../src/web/lib/convert/browser-ops";

const ALL = { features: ["convert_plus", "excel"], engine: true };

describe("R86 formats", () => {
  it("knows video, audio, e-books and archives by name and type", () => {
    expect(formatOf("clip.MOV")).toBe("mov");
    expect(formatOf("a.m4v")).toBe("mp4");
    expect(formatOf("voice.opus")).toBe("ogg");
    expect(formatOf("memo", "audio/x-m4a")).toBe("m4a");
    expect(formatOf("book.epub")).toBe("epub");
    expect(formatOf("kindle.azw")).toBe("mobi");
    expect(formatOf("photos.tar.gz")).toBe("tgz");
    expect(formatOf("files", "application/x-zip-compressed")).toBe("zip");
    expect(formatOf("x.7z")).toBe("7z");
  });
  it("keeps both parts of .tar.gz when renamed", () => {
    expect(renameTo("photos.tar.gz", "zip")).toBe("photos.zip");
    expect(renameTo("photos.zip", "tgz")).toBe("photos.tar.gz");
  });
});

describe("R86 routes", () => {
  it("video and audio change on the engine in one run, and nothing chains after", () => {
    const r = routeTo("mov", "mp4", ALL)!;
    expect(r.steps.map((s) => s.op)).toEqual(["media-convert"]);
    expect(r.steps[0].options).toEqual({ to: "mp4" });
    expect(r.local).toBe(false);
    expect(routeTo("mp4", "gif", ALL)!.steps).toHaveLength(1);
    expect(routeTo("mp4", "mp3", ALL)!.steps).toHaveLength(1);
    expect(routeTo("wav", "m4a", ALL)!.steps[0].options).toEqual({ to: "m4a" });
    // A video's GIF is not a starting point for more steps (no GIF to PNG to PDF from a video).
    expect(routeTo("mp4", "png", ALL)).toBeNull();
    expect(routeTo("mp4", "pdf", ALL)).toBeNull();
    expect(routeTo("mp3", "mp4", ALL)).toBeNull();
  });
  it("needs the engine and convert_plus for video", () => {
    expect(planRoutes("mov", { ...ALL, engine: false })).toEqual([]);
    expect(planRoutes("mov", { features: [], engine: true })).toEqual([]);
  });
  it("HEIC stays on the device where the browser opens it, and goes to the engine where it can't", () => {
    expect(routeTo("heic", "jpg", { ...ALL, caps: ALL_CAPS })!.local).toBe(true);
    const off = { ...ALL, caps: { ...ALL_CAPS, heicDecode: false } };
    const r = routeTo("heic", "jpg", off)!;
    expect(r.local).toBe(false);
    expect(r.steps.map((s) => s.op)).toEqual(["photo-convert"]);
    expect(r.steps[0].options).toEqual({ to: "jpg" });
    // From JPG on, the rest runs on the device: HEIC to WEBP is one engine run.
    const webp = routeTo("heic", "webp", off)!;
    expect(webp.steps.map((s) => s.where)).toEqual(["engine", "browser"]);
    // Without the engine, a browser that can't open HEIC has nowhere to go.
    expect(planRoutes("heic", { ...off, engine: false })).toEqual([]);
  });
  it("e-books become PDFs on the engine", () => {
    expect(routeTo("epub", "pdf", ALL)!.steps.map((s) => s.op)).toEqual(["ebook-to-pdf"]);
    expect(routeTo("mobi", "pdf", ALL)!.local).toBe(false);
  });
  it("archives change kind on the device; 7Z and RAR are read, not written", () => {
    const r = routeTo("7z", "zip", ALL)!;
    expect(r.local).toBe(true);
    expect(r.steps.map((s) => s.run)).toEqual(["archive"]);
    expect(routeTo("rar", "tgz", ALL)!.local).toBe(true);
    expect(routeTo("zip", "7z", ALL)).toBeNull();
    expect(routeTo("zip", "rar", ALL)).toBeNull();
    // A browser without WebAssembly can't open archives.
    expect(planRoutes("zip", { ...ALL, caps: { ...ALL_CAPS, archive: false } })).toEqual([]);
  });
  it("a batch of videos shares its targets", () => {
    expect(commonTargets(["mov", "webm"], ALL).map((t) => t.to)).toEqual(["mp4", "mov", "webm", "mp3", "m4a", "wav", "gif"]);
  });
});

describe("R86 actions", () => {
  it("compress, OCR, unpack and pack fit the right files", () => {
    expect(actionsFor(["zip"]).map((a) => a.id)).toEqual(["extract", "archive"]);
    expect(actionsFor(["mp4"]).map((a) => a.id)).toEqual(["compress", "archive"]);
    expect(actionsFor(["docx"]).map((a) => a.id)).toEqual(["archive"]);
  });
  it("counts engine runs and leaves engine actions out without the engine", () => {
    const compress = ACTIONS.find((a) => a.id === "compress")!;
    expect(actionEngineRuns(compress, ["pdf", "jpg", "mp4"])).toBe(2);
    expect(actionEngineRuns(compress, ["jpg", "png"])).toBe(0);
    expect(actionsFor(["jpg"], { engine: false }).map((a) => a.id)).toContain("compress");
    expect(actionsFor(["pdf"], { engine: false }).map((a) => a.id)).not.toContain("compress");
    expect(actionsFor(["pdf"], { engine: false }).map((a) => a.id)).not.toContain("ocr-pdf");
    expect(actionsFor(["mp4"], { engine: true, features: [] }).map((a) => a.id)).not.toContain("compress");
    expect(actionsFor(["mp4"], { engine: true, features: ["convert_plus"] }).map((a) => a.id)).toContain("compress");
  });
  it("action copy has no dashes", () => {
    for (const a of ACTIONS) expect(`${a.label} ${a.line}`, a.id).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("R86 catalogue", () => {
  it("has the four engine tools on convert_plus with their result types", () => {
    for (const op of ["media-convert", "media-compress", "photo-convert", "ebook-to-pdf"] as const) {
      expect(TOOLS.some((t) => t.op === op), op).toBe(true);
      expect(toolDef(op).feature, op).toBe("convert_plus");
    }
    expect(catalogueFor([]).some((t) => t.op === "media-convert")).toBe(false);
    expect(catalogueFor(["convert_plus"]).some((t) => t.op === "media-convert")).toBe(true);
    expect(resultExt(toolDef("media-convert"), { to: "gif" })).toBe("gif");
    expect(resultExt(toolDef("photo-convert"), { to: "png" })).toBe("png");
    expect(extForType("audio/mp4")).toBe("m4a");
    expect(EXT_TYPES.mov).toBe("video/quicktime");
    expect(toolDef("media-convert").maxBytes).toBe(100 * 1024 * 1024);
  });
  it("a compress that changed nothing is not counted, for video too", () => {
    expect(emptyResult("media-compress", { in_bytes: 1000, out_bytes: 1000, already_optimised: true })).toBe(true);
    expect(emptyResult("media-compress", { in_bytes: 1000, out_bytes: 400 })).toBe(false);
  });
});

describe("R86 archives on the device", () => {
  it("makes archive paths safe", () => {
    expect(safeArchivePath("../../etc/passwd")).toBe("etc/passwd");
    expect(safeArchivePath("/abs/x.txt")).toBe("abs/x.txt");
    expect(safeArchivePath("C:\\Users\\a.txt")).toBe("Users/a.txt");
    expect(safeArchivePath("ok/./name\u0007.txt")).toBe("ok/name.txt");
  });
  it("writes a valid USTAR tar", async () => {
    const tar = await tarFiles([new File(["hello"], "a.txt"), new File([new Uint8Array(600)], "b.bin")]);
    expect(tar.length % 512).toBe(0);
    expect(new TextDecoder().decode(tar.slice(0, 5))).toBe("a.txt");
    expect(new TextDecoder().decode(tar.slice(257, 262))).toBe("ustar");
    // Header checksum: the sum of the header bytes with the checksum field as spaces.
    const h = tar.slice(0, 512);
    const stored = parseInt(new TextDecoder().decode(h.slice(148, 154)), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    expect(stored).toBe(sum);
    expect(new TextDecoder().decode(tar.slice(512, 517))).toBe("hello");
    // a.txt: header and one block; b.bin: header and two blocks; then two empty blocks.
    expect(tar.length).toBe(512 * (2 + 3 + 2));
  });
});
