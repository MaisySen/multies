import { describe, it, expect } from "vitest";
import { dateLocale, dateOrder, datePattern, formatDateValue, parseDateValue, setDisplayLocale } from "@/web/lib/date-input";
import { nextDocNumber } from "@/shared/tools-automation";

describe("R67 dates in the workspace's order (MB-250)", () => {
  it("follows the workspace country, in the person's language", () => {
    setDisplayLocale("en", "AU");
    expect(dateLocale()).toBe("en-AU");
    expect(dateOrder()).toBe("dmy");
    expect(datePattern()).toBe("dd/mm/yyyy");
    setDisplayLocale("en-US", "AU");
    expect(dateOrder()).toBe("dmy");
    setDisplayLocale("en", "US");
    expect(dateOrder()).toBe("mdy");
    setDisplayLocale(null, null);
    expect(dateLocale()).toBe("en-AU");
  });
  it("shows ISO values in that order and reads what people type", () => {
    expect(formatDateValue("2026-11-23", "dmy")).toBe("23/11/2026");
    expect(formatDateValue("2026-11-23", "mdy")).toBe("11/23/2026");
    expect(formatDateValue("", "dmy")).toBe("");
    expect(parseDateValue("23/11/2026", "dmy")).toBe("2026-11-23");
    expect(parseDateValue("3.4.26", "dmy")).toBe("2026-04-03");
    expect(parseDateValue("2026-04-03", "dmy")).toBe("2026-04-03");
    expect(parseDateValue("11/23/2026", "mdy")).toBe("2026-11-23");
    expect(parseDateValue("31/02/2026", "dmy")).toBeNull();
    expect(parseDateValue("23/11", "dmy")).toBeNull();
    expect(parseDateValue("23/11/202", "dmy")).toBeNull();
  });
});

describe("R67 next invoice number (QA5 #16)", () => {
  it("counts on from the last one, keeping its shape", () => {
    expect(nextDocNumber(null, "invoice")).toBe("INV-0001");
    expect(nextDocNumber(undefined, "quote")).toBe("Q-0001");
    expect(nextDocNumber("INV-0041", "invoice")).toBe("INV-0042");
    expect(nextDocNumber("INV-0999", "invoice")).toBe("INV-1000");
    expect(nextDocNumber("2026/9", "invoice")).toBe("2026/10");
    expect(nextDocNumber("A12-B", "invoice")).toBe("A13-B");
    expect(nextDocNumber("draft", "invoice")).toBe("INV-0001");
  });
});
