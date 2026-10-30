/**
 * Tools UX: the Tools page's list (sections, search, what takes a file), names that keep both ends, the saved size
 * line, the short attachment menu, and the engine warm up route.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { TOOLS, catalogueFor } from "@/shared/tools";
import { TOOL_FEATURES } from "@/shared/tool-features";
import { SECTIONS, buildEntries, entryTakes, middleTruncate, savedLine, searchEntries } from "@/web/components/tools/tool-directory";
import { attachmentActions } from "@/web/pages/app/mail/attachment-tools";

const ALL = [...TOOL_FEATURES];

describe("Tools UX list", () => {
  it("puts every tool and Tools page in one of five sections, each with its own short line", () => {
    const entries = buildEntries(catalogueFor(ALL), ALL);
    expect(new Set(entries.map((e) => e.section))).toEqual(new Set(SECTIONS));
    for (const e of entries) {
      expect(e.line.length, e.key).toBeLessThanOrEqual(48);
      expect(e.line, e.key).not.toMatch(/[\u2013\u2014]/);
    }
    // Every catalogue tool with a card has its own look (no fallback icon or line).
    for (const t of TOOLS.filter((x) => !x.hidden)) expect(entries.find((e) => e.key === t.op)?.line, t.op).not.toBe(t.blurb);
    // AI helpers, share, sign and automation are in the same list.
    for (const k of ["ask", "translate", "extract", "expenses", "contracts", "esign", "share", "workflows", "templates", "merge_mail", "rules"]) expect(entries.some((e) => e.key === k), k).toBe(true);
  });

  it("shows only P1 tools and no pages when no P2 feature is on", () => {
    const entries = buildEntries(catalogueFor([]), []);
    expect(entries.every((e) => !!e.tool)).toBe(true);
    expect(entries.map((e) => e.key)).toContain("compress");
    expect(entries.map((e) => e.key)).not.toContain("protect");
  });

  it("search matches names, lines and everyday words", () => {
    const entries = buildEntries(catalogueFor(ALL), ALL);
    expect(searchEntries(entries, "smaller").map((e) => e.key)).toContain("compress");
    expect(searchEntries(entries, "word").map((e) => e.key)).toEqual(expect.arrayContaining(["convert", "pdf-to-docx"]));
    expect(searchEntries(entries, "signature").map((e) => e.key)).toContain("esign");
    expect(searchEntries(entries, "zzzz")).toEqual([]);
  });

  it("a dropped file shows only the tools that take it", () => {
    const entries = buildEntries(catalogueFor(ALL), ALL);
    const forDocx = entries.filter((e) => entryTakes(e, "Quote.docx")).map((e) => e.key);
    expect(forDocx).toContain("convert");
    expect(forDocx).not.toContain("compress");
    const forPdf = entries.filter((e) => entryTakes(e, "Lease.pdf")).map((e) => e.key);
    expect(forPdf).toEqual(expect.arrayContaining(["compress", "protect", "esign", "ask"]));
    expect(forPdf).not.toContain("merge"); // needs two files
  });

  it("long names keep their start and their end", () => {
    const n = middleTruncate("Lease agreement 2026 final version signed copy.pdf", 30);
    expect(n.length).toBe(30);
    expect(n.startsWith("Lease agree")).toBe(true);
    expect(n.endsWith("copy.pdf")).toBe(true);
    expect(middleTruncate("short.pdf", 30)).toBe("short.pdf");
  });

  it("says how much smaller a compressed file got", () => {
    expect(savedLine(27 * 1024, 3 * 1024)).toBe("27 KB to 3 KB, 89% smaller");
    expect(savedLine(3 * 1024, 3 * 1024)).toBe("3 KB to 3 KB. This file was already small.");
  });
});

describe("Tools UX attachment menu", () => {
  it("lists at most five actions, the most useful first", () => {
    const pdf = attachmentActions("Lease.pdf", ALL, "attachment=a1&name=Lease.pdf");
    expect(pdf.map((a) => a.label)).toEqual(["Compress PDF", "Edit pages", "Sign", "Share as a link", "Ask this document"]);
    expect(pdf[0].to).toBe("/app/tools?op=compress&attachment=a1&name=Lease.pdf");
    expect(pdf[2].to).toBe("/app/tools/sign?attachment=a1&name=Lease.pdf");
    expect(pdf[4].to).toBe("/app/tools/ai?feature=ask&attachment=a1&name=Lease.pdf");
    const docx = attachmentActions("Quote.docx", ALL, "q=1");
    expect(docx[0].label).toBe("Convert to PDF");
    expect(docx.length).toBeLessThanOrEqual(5);
  });

  it("falls back to the P1 tools when no P2 feature is on", () => {
    expect(attachmentActions("Lease.pdf", [], "q=1").map((a) => a.label)).toEqual(["Compress PDF", "PDF to Word", "Make searchable (OCR)", "Redact text"]);
  });
});

describe("Tools UX warm up", () => {
  const ON = { TOOLS_ENABLED: "true", DOC_ENGINE_URL: "https://engine.test", DOC_ENGINE_KEY_ID: "stg-1", DOC_ENGINE_KEY: "k".repeat(40), TOOLS_TOKEN_KEY: "t".repeat(40) };
  it("pings the engine's health once, then answers from memory for a while; off without Tools", async () => {
    let pings = 0;
    const fetch = (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === "/healthz") { pings++; return Response.json({ ok: true }); }
      return new Response("no", { status: 404 });
    }) as typeof globalThis.fetch;
    const ctx = await makeTestApp(ON, { fetch });
    const c = new Client(ctx.app);
    await c.signup(undefined, "Ada Lovelace", "Acme");
    const before = pings;
    const a = await c.get("/api/tools/warm");
    expect(a.status).toBe(200);
    expect((a.body as { ok: boolean }).ok).toBe(true);
    await c.get("/api/tools/warm");
    expect(pings - before).toBeLessThanOrEqual(1);

    const off = await makeTestApp({}, { fetch });
    const c2 = new Client(off.app);
    await c2.signup(undefined, "Grace Hopper", "Navy");
    expect((await c2.get("/api/tools/warm")).status).toBe(404);
  });
});
