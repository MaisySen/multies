import { describe, it, expect } from "vitest";
import { LEGAL_DOCS, SUBPROCESSORS } from "@/shared/legal";

describe("legal pages", () => {
  it("cover the Australian basics", () => {
    const text = (slug: keyof typeof LEGAL_DOCS) => JSON.stringify(LEGAL_DOCS[slug]);
    expect(text("privacy")).toMatch(/Australian Privacy Principles/);
    expect(text("privacy")).toMatch(/Notifiable Data Breaches/);
    expect(text("privacy")).toMatch(/APP 8/);
    expect(text("acceptable-use")).toMatch(/Spam Act 2003/);
    expect(text("acceptable-use")).toMatch(/Consent[\s\S]*Identify[\s\S]*Unsubscribe/);
    expect(text("terms")).toMatch(/Australian Consumer Law/);
    expect(text("dpa")).toMatch(/Standard Contractual Clauses/);
    expect(SUBPROCESSORS.length).toBeGreaterThan(3);
    for (const doc of Object.values(LEGAL_DOCS)) expect(new Set(doc.sections.map((s) => s.id)).size).toBe(doc.sections.length);
  });

});
