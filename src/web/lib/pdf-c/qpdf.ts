/**
 * R100 Tools C: Fix a PDF on the device with qpdf (Apache 2.0) compiled to WebAssembly. The 1.3 MB engine loads only
 * when this tool runs (a static file, cached by the browser), and every run gets a fresh instance so one file never
 * sees another's memory. Nothing is uploaded.
 */
export const QPDF_MAX_BYTES = 100 * 1024 * 1024;

export type FixOp = "repair" | "linearize" | "encrypt";
export interface EncryptOptions { userPassword: string; ownerPassword?: string; allowPrint: boolean; allowCopy: boolean }
export interface FixResult { bytes: Uint8Array; warnings: string[] }

export class QpdfError extends Error {}

interface QpdfInstance { callMain(args: string[]): number; FS: { writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array; unlink(p: string): void } }
export type QpdfFactory = (opts: Record<string, unknown>) => Promise<QpdfInstance>;

/** The command line for an op. Passwords stay inside the page; nothing here is logged. */
export function qpdfArgs(op: FixOp, opts: { password?: string; encrypt?: EncryptOptions } = {}): string[] {
  const pre = opts.password ? [`--password=${opts.password}`] : [];
  if (op === "repair") return [...pre, "--object-streams=preserve", "in.pdf", "out.pdf"];
  if (op === "linearize") return [...pre, "--linearize", "in.pdf", "out.pdf"];
  const e = opts.encrypt;
  if (!e?.userPassword) throw new QpdfError("Type a password to lock the PDF with.");
  if (e.userPassword.length < 4) throw new QpdfError("Use a password of at least 4 characters.");
  if (e.userPassword.length > 127 || (e.ownerPassword?.length ?? 0) > 127) throw new QpdfError("Passwords can be up to 127 characters.");
  const owner = e.ownerPassword || e.userPassword;
  return [...pre, "--encrypt", e.userPassword, owner, "256", `--print=${e.allowPrint ? "full" : "none"}`, `--extract=${e.allowCopy ? "y" : "n"}`, "--", "in.pdf", "out.pdf"];
}

export const LOCKED_MESSAGE = "This PDF is locked. Type its current password and try again.";
export const WRONG_PASSWORD_MESSAGE = "That password is not right. Check it and try again.";

/** Turns qpdf's exit code and messages into a result or a plain sentence. Exit 3 means it worked with warnings.
 * `ctx.encrypted` and `ctx.password` let a failed open of a locked file read as a wrong password: qpdf writes
 * "invalid password" to the console, not to printErr, so the exit code alone often carries it. */
export function readOutcome(code: number, errors: string[], ctx: { encrypted?: boolean; password?: string } = {}): "ok" | "warnings" {
  const all = errors.join("\n");
  if (/invalid password/i.test(all) || (code === 2 && ctx.encrypted && !/not a PDF file|can't find PDF header/i.test(all))) {
    throw new QpdfError(ctx.password ? WRONG_PASSWORD_MESSAGE : LOCKED_MESSAGE);
  }
  if (code === 0) return "ok";
  if (code === 3) return "warnings";
  if (/not a PDF file|can't find PDF header|unable to find trailer/i.test(all)) throw new QpdfError("This file is too damaged to fix, or it is not a PDF.");
  throw new QpdfError("This PDF could not be fixed. It may be too damaged.");
}

let factoryPromise: Promise<QpdfFactory> | null = null;
/** Loads the qpdf script once (same origin, allowed by the page's script policy) and keeps its factory. */
export function loadQpdfFactory(base = "/vendor/qpdf/"): Promise<QpdfFactory> {
  factoryPromise ??= new Promise<QpdfFactory>((resolve, reject) => {
    const w = window as unknown as { Module?: QpdfFactory };
    const prior = w.Module;
    const s = document.createElement("script");
    s.src = `${base}qpdf.js`;
    s.async = true;
    s.onload = () => {
      const f = w.Module; w.Module = prior;
      if (f) resolve(f); else { factoryPromise = null; reject(new QpdfError("The PDF fixer did not load. Check your connection and try again.")); }
    };
    s.onerror = () => { factoryPromise = null; reject(new QpdfError("The PDF fixer did not load. Check your connection and try again.")); };
    document.head.appendChild(s);
  });
  return factoryPromise;
}

export async function runQpdf(input: Uint8Array, op: FixOp, opts: { password?: string; encrypt?: EncryptOptions } = {}, factory?: QpdfFactory, extra: Record<string, unknown> = {}): Promise<FixResult> {
  if (input.byteLength > QPDF_MAX_BYTES) throw new QpdfError("This PDF is over 100 MB. Split it first, then fix each part.");
  if (!input.byteLength) throw new QpdfError("This file is empty.");
  const args = qpdfArgs(op, opts);
  const make = factory ?? await loadQpdfFactory();
  const errors: string[] = [];
  const q = await make({ locateFile: (f: string) => `/vendor/qpdf/${f}`, print: () => {}, printErr: (t: string) => errors.push(t), noInitialRun: true, ...extra });
  q.FS.writeFile("in.pdf", input);
  let code: number;
  try { code = q.callMain(args); } catch (e) {
    const status = (e as { status?: number })?.status;
    code = typeof status === "number" ? status : 2;
  }
  const outcome = readOutcome(code, errors, { encrypted: looksEncrypted(input), password: opts.password });
  let bytes: Uint8Array;
  try { bytes = q.FS.readFile("out.pdf"); } catch { throw new QpdfError("This PDF could not be fixed. It may be too damaged."); }
  return { bytes, warnings: outcome === "warnings" ? errors.filter((l) => /warning/i.test(l)).slice(0, 20).map((l) => l.replace(/^.*?(warning|WARNING):\s*/, "").replace(/in\.pdf/g, "the file")) : [] };
}

/** True when the file carries an encryption dictionary (a password or permissions lock). */
export function looksEncrypted(input: Uint8Array): boolean {
  const tail = input.subarray(Math.max(0, input.byteLength - 64 * 1024));
  let t = ""; for (let i = 0; i < tail.length; i++) t += String.fromCharCode(tail[i]);
  return /\/Encrypt\s/.test(t);
}

/** What the page calls: qpdf first; for Repair, if qpdf cannot rebuild the file, a second reader rebuilds its index. */
export async function fixPdf(input: Uint8Array, op: FixOp, opts: { password?: string; encrypt?: EncryptOptions } = {}, factory?: QpdfFactory, extra: Record<string, unknown> = {}): Promise<FixResult> {
  if (!opts.password && looksEncrypted(input)) throw new QpdfError(LOCKED_MESSAGE);
  try {
    return await runQpdf(input, op, opts, factory, extra);
  } catch (e) {
    if (op !== "repair" || !(e instanceof QpdfError) || looksEncrypted(input) || /locked|password|empty|100 MB/.test(e.message)) throw e;
    const { PDFDocument } = await import("pdf-lib");
    let doc;
    try { doc = await PDFDocument.load(input, { throwOnInvalidObject: false, updateMetadata: false }); } catch { throw new QpdfError("This file is too damaged to fix, or it is not a PDF."); }
    if (!doc.getPageCount()) throw new QpdfError("No pages could be saved from this file. It is too damaged to fix.");
    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, warnings: ["The file's index was damaged and has been rebuilt."] };
  }
}
