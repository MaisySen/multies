/** R125: the pure table rules: field checks and conversion, dates (day first), money, CSV read and write, type guessing. */
import { describe, it, expect } from "vitest";
import { cellText, coerceCell, convertValue, guessType, newOptionLabels, parseCents, parseCsv, parseDate, searchTextOf, TEMPLATES, toCsv, type TField } from "@/shared/tables-r125";
import { checkFormulas, isTablesExcluded } from "@/server/services/tables-r125";

const f = (type: TField["type"], config: TField["config"] = {}, name = "Field"): TField => ({ id: `f_${type}`, name, type, config, position: 1, width: null });
const sel = f("select", { options: [{ id: "a", label: "Lead", color: "#000000" }, { id: "b", label: "Client", color: "#000000" }] });
const multi = f("multiselect", { options: [{ id: "a", label: "Red", color: "#000000" }, { id: "b", label: "Blue", color: "#000000" }] });

describe("R125 field values", () => {
  it("checks text, long text and their limits", () => {
    expect(coerceCell(f("text"), "  Ada \n Lovelace ")).toEqual({ ok: true, value: "Ada Lovelace" });
    expect(coerceCell(f("text"), "x".repeat(2001)).ok).toBe(false);
    expect(coerceCell(f("longtext"), "line 1\r\nline 2")).toEqual({ ok: true, value: "line 1\nline 2" });
    expect(coerceCell(f("text"), "")).toEqual({ ok: true, value: null });
    expect(coerceCell(f("text"), { a: 1 }).ok).toBe(false);
  });
  it("reads numbers and money in cents", () => {
    expect(coerceCell(f("number"), "1,234.5")).toEqual({ ok: true, value: 1234.5 });
    expect(coerceCell(f("number"), "abc")).toMatchObject({ ok: false });
    expect(coerceCell(f("number"), Number.NaN).ok).toBe(false);
    expect(parseCents("A$1,234.50")).toBe(123450);
    expect(parseCents("$12")).toBe(1200);
    expect(parseCents("-3.5")).toBe(-350);
    expect(parseCents("12 AUD")).toBe(1200);
    expect(parseCents("twelve")).toBeNull();
    expect(coerceCell(f("currency"), "0.1")).toEqual({ ok: true, value: 10 });
    expect(coerceCell(f("currency"), 12.5).ok).toBe(false);
    expect(cellText(f("currency", { currency: "AUD" }), 123450)).toBe("$1,234.50");
    expect(cellText(f("currency"), -5)).toBe("-$0.05");
  });
  it("reads dates day first and refuses impossible ones", () => {
    expect(parseDate("2/11/2026")).toBe("2026-11-02");
    expect(parseDate("02-11-26")).toBe("2026-11-02");
    expect(parseDate("2026-11-02")).toBe("2026-11-02");
    expect(parseDate("2026-11-02T10:00:00Z")).toBe("2026-11-02");
    expect(parseDate("2 Nov 2026")).toBe("2026-11-02");
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("13/13/2026")).toBeNull();
    expect(parseDate("tomorrow")).toBeNull();
    expect(cellText(f("date"), "2026-11-02")).toBe("02/11/2026");
  });
  it("checks checkbox, email, phone and web address", () => {
    expect(coerceCell(f("checkbox"), "yes")).toEqual({ ok: true, value: true });
    expect(coerceCell(f("checkbox"), "No")).toEqual({ ok: true, value: false });
    expect(coerceCell(f("checkbox"), "")).toEqual({ ok: true, value: false });
    expect(coerceCell(f("checkbox"), "maybe").ok).toBe(false);
    expect(coerceCell(f("email"), "ada@example.com").ok).toBe(true);
    expect(coerceCell(f("email"), "ada@").ok).toBe(false);
    expect(coerceCell(f("phone"), "+61 412 345 678").ok).toBe(true);
    expect(coerceCell(f("phone"), "call me").ok).toBe(false);
    expect(coerceCell(f("url"), "example.com/a")).toEqual({ ok: true, value: "https://example.com/a" });
    expect(coerceCell(f("url"), "javascript:alert(1)").ok).toBe(false);
    expect(coerceCell(f("url"), "not a url").ok).toBe(false);
  });
  it("matches select options by id or label", () => {
    expect(coerceCell(sel, "client")).toEqual({ ok: true, value: "b" });
    expect(coerceCell(sel, "a")).toEqual({ ok: true, value: "a" });
    expect(coerceCell(sel, "Past").ok).toBe(false);
    expect(coerceCell(multi, "Red, blue, red")).toEqual({ ok: true, value: ["a", "b"] });
    expect(coerceCell(multi, ["b"])).toEqual({ ok: true, value: ["b"] });
    expect(coerceCell(multi, "Green").ok).toBe(false);
    expect(cellText(multi, ["a", "b"])).toBe("Red, Blue");
    expect(newOptionLabels(sel, ["Lead", "Past", "past", ""])).toEqual(["Past"]);
  });
  it("keeps ids for links and attachments and refuses odd ids", () => {
    expect(coerceCell(f("link"), ["row_1", "row_1", "row_2"])).toEqual({ ok: true, value: ["row_1", "row_2"] });
    expect(coerceCell(f("link"), ["bad id"]).ok).toBe(false);
    expect(coerceCell(f("link"), Array.from({ length: 101 }, (_, i) => `r${i}`)).ok).toBe(false);
    expect(coerceCell(f("formula"), "1").ok).toBe(false);
    expect(coerceCell(f("lookup"), null).ok).toBe(false);
  });
  it("converts columns between types", () => {
    expect(convertValue(f("text"), f("number"), "42")).toBe(42);
    expect(convertValue(f("text"), f("number"), "n/a")).toBeNull();
    expect(convertValue(f("number"), f("currency"), 12.5)).toBe(1250);
    expect(convertValue(f("currency"), f("number"), 1250)).toBe(12.5);
    expect(convertValue(f("currency"), f("text"), 1250)).toBe("12.50");
    expect(convertValue(f("date"), f("text"), "2026-11-02")).toBe("2026-11-02");
    expect(convertValue(f("text"), f("date"), "2/11/2026")).toBe("2026-11-02");
    expect(convertValue(sel, f("text"), "b")).toBe("Client");
    expect(convertValue(f("text"), f("checkbox"), "yes")).toBe(true);
    expect(convertValue(f("text"), f("link"), "x")).toBeNull();
    expect(convertValue(f("text"), f("formula"), "x")).toBeNull();
  });
  it("builds the search text from text like cells only", () => {
    const fields = [f("text"), { ...f("number"), id: "n" }, { ...f("link"), id: "l" }];
    expect(searchTextOf(fields, { f_text: "Ada", n: 3, l: ["row_1"] })).toBe("Ada 3");
  });
});

describe("R125 CSV", () => {
  it("reads quotes, doubled quotes, new lines in quotes, CRLF and a byte order mark", () => {
    const rows = parseCsv('\ufeffName,Note\r\n"Lee, Grace","She said ""hi""\nthen left"\r\nTom,\r\n');
    expect(rows).toEqual([["Name", "Note"], ["Lee, Grace", 'She said "hi"\nthen left'], ["Tom", ""]]);
  });
  it("guesses semicolon and tab separators", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("keeps Nepali and emoji as written", () => {
    const rows = parseCsv("नाम,टिप्पणी\nराम,🎉 बधाई छ\n");
    expect(rows[1]).toEqual(["राम", "🎉 बधाई छ"]);
    expect(toCsv(rows)).toContain("🎉 बधाई छ");
  });
  it("writes safe CSV: quotes where needed and formula like cells defused", () => {
    const out = toCsv([["a", 'b "c"', "=SUM(A1)", "x,y"]]);
    expect(out).toBe('\ufeffa,"b ""c""",\'=SUM(A1),"x,y"\r\n');
  });
  it("stops at the row cap", () => {
    expect(parseCsv("a\n".repeat(10), 3)).toHaveLength(3);
  });
  it("guesses column types", () => {
    expect(guessType(["1", "2.5", "", "1,000"])).toBe("number");
    expect(guessType(["$12.00", "A$3"])).toBe("currency");
    expect(guessType(["2/11/2026", "2026-11-03"])).toBe("date");
    expect(guessType(["yes", "no", "Yes"])).toBe("checkbox");
    expect(guessType(["a@b.co", "c@d.io"])).toBe("email");
    expect(guessType(["https://a.com", "http://b.com"])).toBe("url");
    expect(guessType(["Lead", "Client", "Lead", "Lead", "Client", "Past", "Lead"])).toBe("select");
    expect(guessType(["Ada", "Grace"])).toBe("text");
    expect(guessType([])).toBe("text");
  });
});

describe("R125 formulas and exclusion", () => {
  const num = (id: string, name: string): TField => ({ id, name, type: "number", config: {}, position: 1, width: null });
  const fx = (id: string, name: string, formula: string): TField => ({ id, name, type: "formula", config: { formula }, position: 1, width: null });
  it("accepts a good formula and refuses unknown names, bad syntax and loops", () => {
    expect(() => checkFormulas([num("a", "Qty"), num("b", "Cost"), fx("c", "Total", "{Qty} * {Cost}")])).not.toThrow();
    expect(() => checkFormulas([num("a", "Qty"), fx("c", "Total", "{Qty} * {Price}")])).toThrow(/no field called price/i);
    expect(() => checkFormulas([fx("c", "Total", "1 +")])).toThrow();
    expect(() => checkFormulas([fx("x", "A", "{B} + 1"), fx("y", "B", "{A} + 1")])).toThrow(/loop/);
    expect(() => checkFormulas([fx("x", "A", "{A}")])).toThrow(/loop/);
  });
  it("keeps templates' formulas valid", () => {
    for (const t of TEMPLATES) {
      const fields = t.fields.map((x, i): TField => ({ id: x.key, name: x.name, type: x.type, config: x.formula ? { formula: x.formula } : {}, position: i, width: null }));
      expect(() => checkFormulas(fields)).not.toThrow();
    }
  });
  it("keeps the client workspace out", () => {
    expect(isTablesExcluded({ id: "org_1", slug: "vv8k", name: "Client" })).toBe(true);
    expect(isTablesExcluded({ id: "org_1", slug: "acme", name: "Acme" })).toBe(false);
    expect(isTablesExcluded({ id: "org_1", slug: "acme", name: "Acme" }, "acme")).toBe(true);
  });
});
