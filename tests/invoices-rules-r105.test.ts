/** R105: money and Australian tax invoice rules (cents only, GST per line, ABN checksum, A$1,000 buyer rule, numbering, dates). */
import { describe, it, expect } from "vitest";
import {
  abnValid, formatAbn, accountValid, addDays, ageBucket, atoProblems, basQuarter, bsbValid, centsText, daysBetween, divRound, docNumber, docTitle, docTotals,
  gstInPayment, lineAmounts, money, nextRun, parseMoney, parseQty, payState, qtyText, type AtoDoc,
} from "@/shared/invoices";

describe("R105 rounding and lines", () => {
  it("rounds half away from zero on integers", () => {
    expect(divRound(5, 10)).toBe(1); expect(divRound(4, 10)).toBe(0); expect(divRound(-5, 10)).toBe(-1); expect(divRound(15, 10)).toBe(2);
    expect(() => divRound(1.5, 2)).toThrow();
  });
  it("adds 10 percent GST on exclusive prices", () => {
    expect(lineAmounts({ description: "a", quantityMilli: 1000, unitCents: 10000 }, "exclusive")).toEqual({ netCents: 10000, gstCents: 1000, totalCents: 11000 });
    expect(lineAmounts({ description: "a", quantityMilli: 1000, unitCents: 1005 }, "exclusive").gstCents).toBe(101); // 100.5 rounds up
    expect(lineAmounts({ description: "a", quantityMilli: 1000, unitCents: 1004 }, "exclusive").gstCents).toBe(100);
  });
  it("takes one eleventh as GST from inclusive prices", () => {
    expect(lineAmounts({ description: "a", quantityMilli: 1000, unitCents: 11000 }, "inclusive")).toEqual({ netCents: 10000, gstCents: 1000, totalCents: 11000 });
    const l = lineAmounts({ description: "a", quantityMilli: 1000, unitCents: 999 }, "inclusive");
    expect(l.gstCents).toBe(91); expect(l.netCents + l.gstCents).toBe(999);
  });
  it("charges no GST on GST free lines or when not registered", () => {
    expect(lineAmounts({ description: "a", quantityMilli: 2000, unitCents: 500, gstFree: true }, "exclusive")).toEqual({ netCents: 1000, gstCents: 0, totalCents: 1000 });
    expect(lineAmounts({ description: "a", quantityMilli: 1000, unitCents: 500 }, "exclusive", false).gstCents).toBe(0);
  });
  it("handles part quantities in thousandths", () => {
    expect(lineAmounts({ description: "a", quantityMilli: 1500, unitCents: 3333 }, "exclusive").netCents).toBe(5000); // 4999.5 rounds up
    expect(lineAmounts({ description: "a", quantityMilli: 333, unitCents: 100 }, "exclusive").netCents).toBe(33);
  });
  it("adds up lines and splits taxable and GST free", () => {
    const t = docTotals([{ description: "a", quantityMilli: 1000, unitCents: 10000 }, { description: "b", quantityMilli: 1000, unitCents: 5000, gstFree: true }], "exclusive");
    expect(t).toMatchObject({ subtotalCents: 15000, gstCents: 1000, totalCents: 16000, gstFreeCents: 5000, taxableCents: 10000 });
    const many = docTotals(Array.from({ length: 3 }, () => ({ description: "x", quantityMilli: 1000, unitCents: 1 })), "exclusive");
    expect(many.gstCents).toBe(0); // GST is per line, each rounds to 0
    expect(Number.isInteger(t.totalCents)).toBe(true);
  });
});

describe("R105 ABN, BSB and numbering", () => {
  it("checks the ABN checksum", () => {
    expect(abnValid("51 824 753 556")).toBe(true); // the ATO's own example
    expect(abnValid("53 004 085 616")).toBe(true);
    expect(abnValid("51 824 753 557")).toBe(false);
    expect(abnValid("1234567890")).toBe(false); expect(abnValid("")).toBe(false); expect(abnValid(null)).toBe(false); expect(abnValid("01824753556")).toBe(false);
    expect(formatAbn("51824753556")).toBe("51 824 753 556");
  });
  it("checks BSB and account", () => {
    expect(bsbValid("062-000")).toBe(true); expect(bsbValid("06200")).toBe(false);
    expect(accountValid("12345678")).toBe(true); expect(accountValid("1234")).toBe(false);
  });
  it("numbers documents with a prefix and padding", () => {
    expect(docNumber("invoice", 1)).toBe("INV-0001"); expect(docNumber("quote", 42)).toBe("QU-0042"); expect(docNumber("credit_note", 12345)).toBe("CN-12345");
    expect(docNumber("invoice", 7, "ACME")).toBe("ACME-0007");
  });
  it("titles tax invoices and adjustment notes", () => {
    expect(docTitle("invoice", true)).toBe("Tax invoice"); expect(docTitle("invoice", false)).toBe("Invoice");
    expect(docTitle("credit_note", true)).toBe("Adjustment note"); expect(docTitle("quote", true)).toBe("Quote");
  });
});

describe("R105 ATO fields", () => {
  const base: AtoDoc = { kind: "invoice", gstRegistered: true, supplierName: "Fintex", supplierAbn: "51 824 753 556", issueDate: "2026-11-01", buyerName: null, buyerAbn: null, totalCents: 99_999, lines: [{ description: "Work", quantityMilli: 1000, unitCents: 90_908 }] };
  it("passes a complete tax invoice under A$1,000 with no buyer", () => { expect(atoProblems(base)).toEqual([]); });
  it("needs the buyer's name or ABN at A$1,000 or more", () => {
    expect(atoProblems({ ...base, totalCents: 100_000 })).toEqual(["buyer_identity"]);
    expect(atoProblems({ ...base, totalCents: 100_000, buyerName: "Ada" })).toEqual([]);
    expect(atoProblems({ ...base, totalCents: 100_000, buyerAbn: "53004085616" })).toEqual([]);
    expect(atoProblems({ ...base, totalCents: 100_000, gstRegistered: false, supplierAbn: null })).toEqual([]);
  });
  it("needs supplier name, valid ABN, date, lines with description and quantity", () => {
    expect(atoProblems({ ...base, supplierName: " ", supplierAbn: "123", issueDate: null, lines: [{ description: "", quantityMilli: 0, unitCents: 1 }] }))
      .toEqual(["supplier_name", "supplier_abn", "issue_date", "line_description", "line_quantity"]);
    expect(atoProblems({ ...base, lines: [] })).toContain("no_lines");
    expect(atoProblems({ ...base, buyerAbn: "11111111111" })).toEqual(["buyer_abn"]);
  });
  it("needs an adjustment note to name its invoice", () => {
    expect(atoProblems({ ...base, kind: "credit_note" })).toEqual(["credit_source"]);
    expect(atoProblems({ ...base, kind: "credit_note", sourceNumber: "INV-0001" })).toEqual([]);
  });
  it("only needs lines on a quote", () => { expect(atoProblems({ ...base, kind: "quote", supplierAbn: null })).toEqual([]); });
});

describe("R105 payment state, parsing, dates and reports", () => {
  const d = { issued: true, voided: false, totalCents: 1000, paidCents: 0, dueDate: "2026-11-10" };
  it("works out unpaid, part paid, paid, overdue, void and draft", () => {
    expect(payState(d, "2026-11-01")).toBe("unpaid");
    expect(payState({ ...d, paidCents: 400 }, "2026-11-01")).toBe("part_paid");
    expect(payState({ ...d, paidCents: 1000 }, "2026-12-01")).toBe("paid");
    expect(payState({ ...d, paidCents: 600, creditedCents: 400 }, "2026-12-01")).toBe("paid");
    expect(payState({ ...d, paidCents: 400 }, "2026-11-11")).toBe("overdue");
    expect(payState({ ...d, voided: true }, "2026-11-01")).toBe("void");
    expect(payState({ ...d, issued: false }, "2026-11-01")).toBe("draft");
  });
  it("parses money and quantities without floats", () => {
    expect(parseMoney("1,234.5")).toBe(123450); expect(parseMoney("$20")).toBe(2000); expect(parseMoney("0.07")).toBe(7); expect(parseMoney("-3.10")).toBe(-310);
    expect(parseMoney("1.234")).toBeNull(); expect(parseMoney("abc")).toBeNull();
    expect(parseQty("1.5")).toBe(1500); expect(parseQty("2")).toBe(2000); expect(parseQty("0.125")).toBe(125); expect(parseQty("1.2345")).toBeNull();
    expect(qtyText(1500)).toBe("1.5"); expect(qtyText(2000)).toBe("2");
    expect(centsText(123456789)).toBe("1,234,567.89"); expect(money(-505)).toBe("-$5.05"); expect(money(100, "USD")).toBe("USD 1.00");
  });
  it("does calendar maths and repeats with month end clamping", () => {
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08"); expect(daysBetween("2026-11-01", "2026-12-01")).toBe(30);
    expect(nextRun("2026-01-31", "month")).toBe("2026-02-28"); expect(nextRun("2026-02-28", "month", 31)).toBe("2026-03-31");
    expect(nextRun("2026-11-30", "quarter")).toBe("2027-02-28"); expect(nextRun("2028-02-29", "year")).toBe("2029-02-28");
    expect(nextRun("2026-11-01", "fortnight")).toBe("2026-11-15");
  });
  it("ages receivables and finds BAS quarters", () => {
    expect(ageBucket("2026-11-10", "2026-11-10")).toBe("current"); expect(ageBucket("2026-11-10", "2026-11-11")).toBe("d1_30");
    expect(ageBucket("2026-08-01", "2026-11-11")).toBe("d90_plus"); expect(ageBucket(null, "2026-11-11")).toBe("current");
    expect(basQuarter("2026-11-01")).toEqual({ from: "2026-10-01", to: "2026-12-31", label: "Q2 FY2027" });
    expect(basQuarter("2026-03-15")).toEqual({ from: "2026-01-01", to: "2026-03-31", label: "Q3 FY2026" });
  });
  it("splits GST out of a part payment for cash basis", () => {
    expect(gstInPayment(5500, 11000, 1000)).toBe(500); expect(gstInPayment(0, 0, 0)).toBe(0);
  });
});
