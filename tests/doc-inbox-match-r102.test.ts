import { describe, it, expect } from "vitest";
import { applyRules, detectFields, detectSender, detectType, editDistance, findAmounts, findDates, patternProblem, ruleMatches, type ApplyRule } from "@/server/services/suite/doc-inbox-match";
import { centsLabel, parseCentsInput } from "@/shared/doc-inbox";

/** R102 Smart document inbox: detection and matching (pure). Made up documents only. */
const INVOICE = `Harbour Supplies Pty Ltd
TAX INVOICE
ABN 51 824 753 556
Invoice date: 1/11/2026
Due date: 15 Nov 2026
Office chairs x 4        $1,800.00
GST 10%                  $180.00
Total including GST      $1,980.00
Amount due AUD 1,980.00`;
const RECEIPT = `Deskgear
RECEIPT
Date 3 November 2026
Two keyboards
Subtotal $59.00
GST $5.90
Total paid $64.90
Thank you for your purchase`;
const NOA = `Australian Taxation Office
Notice of assessment
Date of issue 2026-08-14
Your taxable income $84,000
Amount payable $1,234.50`;

describe("R102 dates", () => {
  it("reads Australian day first numeric dates and named months", () => {
    expect(findDates("on 1/11/2026 and 01-11-26").map((d) => d.date)).toEqual(["2026-11-01", "2026-11-01"]);
    expect(findDates("1 Nov 2026, 1 November 2026, Nov 1, 2026, 2026-11-01, 21st March 2027").map((d) => d.date))
      .toEqual(["2026-11-01", "2026-11-01", "2026-11-01", "2026-11-01", "2027-03-21"]);
  });
  it("skips impossible dates and plain numbers", () => {
    expect(findDates("31/02/2026 13/13/2026 ABN 51 824 753 556 1234")).toEqual([]);
  });
});

describe("R102 amounts", () => {
  it("reads $, AUD, A$, thousands and cents", () => {
    expect(findAmounts("$1,234.50").map((a) => a.cents)).toEqual([123450]);
    expect(findAmounts("AUD 1,234.50").map((a) => [a.cents, a.currency])).toEqual([[123450, "AUD"]]);
    expect(findAmounts("A$99").map((a) => a.cents)).toEqual([9900]);
    expect(findAmounts("1,234.50 AUD").map((a) => a.cents)).toEqual([123450]);
    expect(findAmounts("USD 10.00")[0].currency).toBe("USD");
  });
  it("ignores percentages, dates and whole numbers without a sign", () => {
    expect(findAmounts("GST 10% on 1.11.2026 for 4 chairs, ABN 51 824 753 556")).toEqual([]);
  });
});

describe("R102 fields", () => {
  it("finds the total, GST, dates, type and sender of a tax invoice", () => {
    const f = detectFields(INVOICE);
    expect(f).toMatchObject({ type: "bill", sender: "Harbour Supplies Pty Ltd", docDate: "2026-11-01", dueDate: "2026-11-15", amount: 198000, gst: 18000, currency: "AUD", paid: false });
  });
  it("a receipt is paid", () => {
    const f = detectFields(RECEIPT);
    expect(f).toMatchObject({ type: "receipt", docDate: "2026-11-03", amount: 6490, gst: 590, paid: true });
  });
  it("a notice of assessment is a tax document", () => {
    const f = detectFields(NOA);
    expect(f.type).toBe("tax");
    expect(f.docDate).toBe("2026-08-14");
    expect(f.amount).toBe(123450);
    expect(f.sender).toBe(null);
  });
  it("an invoice with nothing left to pay is paid", () => {
    expect(detectFields("TAX INVOICE\nTotal $50.00\nPaid $50.00\nBalance due $0.00").paid).toBe(true);
  });
  it("types and senders from plain words", () => {
    expect(detectType("SERVICE AGREEMENT between the parties")).toBe("contract");
    expect(detectType("hello")).toBe("other");
    expect(detectType("Business activity statement Q1")).toBe("tax");
    expect(detectSender("From: Acme Cleaning\nInvoice")).toBe("Acme Cleaning");
    expect(detectSender("Bright Sparks Electrical\nABN 12 345 678 901\nInvoice")).toBe("Bright Sparks Electrical");
  });
  it("empty text finds nothing", () => {
    expect(detectFields("")).toMatchObject({ type: "other", amount: null, gst: null, docDate: null, dueDate: null, paid: false });
  });
});

describe("R102 matching", () => {
  const ctx = (text: string) => ({ text });
  it("any, all and exact", () => {
    expect(ruleMatches({ match: "any", pattern: "telstra optus", caseSensitive: false }, ctx("Your Optus bill"))).toBe(true);
    expect(ruleMatches({ match: "any", pattern: "telstra vodafone", caseSensitive: false }, ctx("Your Optus bill"))).toBe(false);
    expect(ruleMatches({ match: "all", pattern: "optus bill", caseSensitive: false }, ctx("Your Optus bill"))).toBe(true);
    expect(ruleMatches({ match: "all", pattern: "optus invoice", caseSensitive: false }, ctx("Your Optus bill"))).toBe(false);
    expect(ruleMatches({ match: "exact", pattern: "tax  invoice", caseSensitive: false }, ctx("TAX\nINVOICE 22"))).toBe(true);
    expect(ruleMatches({ match: "exact", pattern: "Tax invoice", caseSensitive: true }, ctx("TAX INVOICE"))).toBe(false);
    // Whole words: "bill" does not match "billing".
    expect(ruleMatches({ match: "any", pattern: "bill", caseSensitive: false }, ctx("billing team"))).toBe(false);
  });
  it("regex, and a bad pattern never matches and is refused", () => {
    expect(ruleMatches({ match: "regex", pattern: "INV-\\d{4}", caseSensitive: false }, ctx("ref inv-2207"))).toBe(true);
    expect(patternProblem("regex", "(a+)+$")).toMatch(/repeats/);
    expect(patternProblem("regex", "(a|aa)*b")).toMatch(/repeats/);
    expect(patternProblem("regex", "(x)\\1")).toMatch(/refer back/);
    expect(patternProblem("regex", "([a-z")).toMatch(/not valid/);
    expect(patternProblem("regex", "x".repeat(201))).toMatch(/under 200/);
    expect(patternProblem("any", "  ")).toMatch(/Add the words/);
    expect(ruleMatches({ match: "regex", pattern: "(a+)+$", caseSensitive: false }, ctx("a".repeat(40) + "!"))).toBe(false);
  });
  it("regex stops when its time is up", () => {
    let t = 0;
    const now = () => (t += 30);
    const text = "x".repeat(20_000) + " needle";
    expect(ruleMatches({ match: "regex", pattern: "needle", caseSensitive: false }, { text, now })).toBe(false);
    expect(ruleMatches({ match: "regex", pattern: "needle", caseSensitive: false }, { text })).toBe(true);
  });
  it("regex finds a match across a chunk edge", () => {
    const text = "y".repeat(1995) + "INV-12345";
    expect(ruleMatches({ match: "regex", pattern: "INV-\\d{5}", caseSensitive: false }, ctx(text))).toBe(true);
  });
  it("fuzzy allows small typos by word length", () => {
    expect(editDistance("telstra", "telsta", 1)).toBe(1);
    expect(ruleMatches({ match: "fuzzy", pattern: "telstra", caseSensitive: false }, ctx("Telsta mobile"))).toBe(true);
    expect(ruleMatches({ match: "fuzzy", pattern: "electricity", caseSensitive: false }, ctx("electrcity bill"))).toBe(true);
    expect(ruleMatches({ match: "fuzzy", pattern: "gas", caseSensitive: false }, ctx("gap"))).toBe(false);
    expect(ruleMatches({ match: "fuzzy", pattern: "water", caseSensitive: false }, ctx("winter"))).toBe(false);
  });
});

describe("R102 rule order and conflicts", () => {
  const rule = (p: Partial<ApplyRule>): ApplyRule => ({ id: "r", match: "any", pattern: "optus", caseSensitive: false, enabled: true, position: 0, setTags: [], setSender: null, setType: null, setFolderId: null, ...p });
  it("tags add up; sender, type and folder come from the first rule that sets them", () => {
    const out = applyRules([
      rule({ id: "b", position: 1, setTags: ["phone"], setSender: "Second", setType: "receipt", setFolderId: "f2" }),
      rule({ id: "a", position: 0, setTags: ["bills", "phone"], setSender: "Optus", setType: "bill" }),
      rule({ id: "c", position: 2, pattern: "nope", setTags: ["never"] }),
      rule({ id: "d", position: 3, enabled: false, setTags: ["off"] }),
    ], "Optus monthly bill", new Set());
    expect(out).toEqual({ applied: ["a", "b"], tags: ["bills", "phone"], sender: "Optus", type: "bill", folderId: "f2" });
  });
  it("fields a person corrected are never changed by rules", () => {
    const out = applyRules([rule({ id: "a", setSender: "Optus", setType: "bill" })], "optus", new Set(["sender", "type"]));
    expect(out.sender).toBeUndefined();
    expect(out.type).toBeUndefined();
    expect(out.applied).toEqual(["a"]);
  });
});

describe("R102 money labels", () => {
  it("formats and parses cents", () => {
    expect(centsLabel(123450)).toBe("$1,234.50");
    expect(centsLabel(500, "USD")).toBe("USD 5.00");
    expect(centsLabel(null)).toBe("");
    expect(parseCentsInput("$1,234.5")).toBe(123450);
    expect(parseCentsInput("")).toBe(null);
    expect(Number.isNaN(parseCentsInput("abc"))).toBe(true);
  });
});
