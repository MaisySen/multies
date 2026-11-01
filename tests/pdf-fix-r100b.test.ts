import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { fixPdf, readOutcome, LOCKED_MESSAGE, WRONG_PASSWORD_MESSAGE, type QpdfFactory } from "../src/web/lib/pdf-c/qpdf";

const req = createRequire(import.meta.url);
// The app package is ESM, so node reads the vendored loader as CommonJS from a .cjs copy.
const cjs = join(tmpdir(), "r100b-qpdf-test.cjs");
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

describe("R100b Fix a PDF: wrong current password", () => {
  it("reads a failed open of a locked file as a wrong password, not a damaged file", () => {
    expect(() => readOutcome(2, ["in.pdf: invalid password"], { encrypted: true, password: "nope" })).toThrow(WRONG_PASSWORD_MESSAGE);
    expect(() => readOutcome(2, [], { encrypted: true, password: "nope" })).toThrow(WRONG_PASSWORD_MESSAGE);
    expect(() => readOutcome(2, [], { encrypted: true })).toThrow(LOCKED_MESSAGE);
    expect(() => readOutcome(2, ["in.pdf: not a PDF file"], { encrypted: true, password: "x" })).toThrow(/too damaged/);
    expect(() => readOutcome(2, [], { encrypted: false, password: "x" })).toThrow(/could not be fixed/);
  });

  for (const op of ["repair", "linearize", "encrypt"] as const) {
    it(`${op}: a wrong password says so, and the right one then works`, async () => {
      const locked = (await run(await sample(), "encrypt", { encrypt: { userPassword: "right-pass", allowPrint: true, allowCopy: true } })).bytes;
      const enc = op === "encrypt" ? { userPassword: "new-pass", allowPrint: true, allowCopy: true } : undefined;
      await expect(run(locked, op, { password: "wrong-pass", encrypt: enc })).rejects.toThrow(WRONG_PASSWORD_MESSAGE);
      await expect(run(locked, op, { encrypt: enc })).rejects.toThrow(LOCKED_MESSAGE);
      const ok = await run(locked, op, { password: "right-pass", encrypt: enc });
      expect(ok.bytes.byteLength).toBeGreaterThan(100);
    }, 60000);
  }
});
