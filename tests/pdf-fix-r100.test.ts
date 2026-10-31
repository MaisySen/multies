import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { fixPdf, looksEncrypted, qpdfArgs, readOutcome, type QpdfFactory } from "../src/web/lib/pdf-c/qpdf";

const req = createRequire(import.meta.url);
// The app package is ESM, so node reads the vendored loader as CommonJS from a .cjs copy.
const cjs = join(tmpdir(), "r100-qpdf-test.cjs");
copyFileSync(new URL("../public/vendor/qpdf/qpdf.js", import.meta.url), cjs);
const mod = req(cjs) as QpdfFactory | { default: QpdfFactory };
const factory = (typeof mod === "function" ? mod : mod.default) as QpdfFactory;
const wasmPath = new URL("../public/vendor/qpdf/qpdf.wasm", import.meta.url).pathname;
const wasmBinary = readFileSync(wasmPath);
const run = (b: Uint8Array, op: Parameters<typeof fixPdf>[1], o: Parameters<typeof fixPdf>[2] = {}) => fixPdf(b, op, o, factory, { wasmBinary, locateFile: () => wasmPath });

async function sample(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < 3; i++) d.addPage([300, 300]).drawText(`Page ${i + 1}`, { x: 20, y: 200 });
  return d.save({ useObjectStreams: false });
}

describe("R100 Fix a PDF (qpdf)", () => {
  it("builds command lines and refuses weak passwords", () => {
    expect(qpdfArgs("linearize")).toEqual(["--linearize", "in.pdf", "out.pdf"]);
    expect(qpdfArgs("encrypt", { encrypt: { userPassword: "abcd", allowPrint: true, allowCopy: false } })).toEqual(["--encrypt", "abcd", "abcd", "256", "--print=full", "--extract=n", "--", "in.pdf", "out.pdf"]);
    expect(() => qpdfArgs("encrypt", { encrypt: { userPassword: "ab", allowPrint: true, allowCopy: true } })).toThrow(/at least 4/);
    expect(() => qpdfArgs("encrypt")).toThrow(/Type a password/);
  });
  it("reads outcomes", () => {
    expect(readOutcome(0, [])).toBe("ok");
    expect(readOutcome(3, ["WARNING: x"])).toBe("warnings");
    expect(() => readOutcome(2, ["in.pdf: invalid password"])).toThrow(/locked/);
    expect(() => readOutcome(2, ["in.pdf: not a PDF file"])).toThrow(/too damaged/);
  });
  it("repairs a PDF with a broken table of contents", async () => {
    const good = await sample();
    const text = new TextDecoder("latin1").decode(good);
    const broken = Uint8Array.from(text.replace(/startxref\s+\d+/, "startxref\n20"), (c) => c.charCodeAt(0));
    const out = await run(broken, "repair");
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(out.warnings.length).toBeGreaterThan(0);
    expect(looksEncrypted(good)).toBe(false);
  }, 60_000);
  it("linearizes and encrypts, and a locked PDF asks for its password", async () => {
    const lin = await run(await sample(), "linearize");
    expect(new TextDecoder("latin1").decode(lin.bytes.slice(0, 1200))).toMatch(/Linearized/);
    const enc = await run(await sample(), "encrypt", { encrypt: { userPassword: "s3cret!", allowPrint: true, allowCopy: false } });
    expect(new TextDecoder("latin1").decode(enc.bytes)).toMatch(/\/Encrypt/);
    expect(looksEncrypted(enc.bytes)).toBe(true);
    await expect(run(enc.bytes, "repair")).rejects.toThrow(/locked/);
    const opened = await run(enc.bytes, "repair", { password: "s3cret!" });
    expect(opened.bytes.byteLength).toBeGreaterThan(100);
  }, 60_000);
  it("refuses junk and empty files", async () => {
    await expect(run(new TextEncoder().encode("hello, not a pdf"), "repair")).rejects.toThrow(/too damaged|not a PDF/);
    await expect(run(new Uint8Array(), "repair")).rejects.toThrow(/empty/);
  }, 60_000);
});
