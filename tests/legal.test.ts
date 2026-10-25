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

  it("privacy policy covers connected mailboxes and free addresses, consistent with the terms", () => {
    const privacy = JSON.stringify(LEGAL_DOCS.privacy);
    const terms = JSON.stringify(LEGAL_DOCS.terms);
    const ids = LEGAL_DOCS.privacy.sections.map((s) => s.id);
    expect(ids).toContain("connected");
    expect(ids).toContain("free-address");
    expect(privacy).toMatch(/encrypted before it is stored/);
    expect(privacy).toMatch(/only to sync that mailbox and to send mail from it/);
    expect(privacy).toMatch(/When you remove the connection, we delete it straight away/);
    expect(privacy).toMatch(/copy that mailbox's messages[^"]*into your workspace/);
    expect(privacy).toMatch(/mail\.multies\.si/);
    expect(privacy).toMatch(/not given to anyone else/);
    // The terms say the same three things about connected mailbox passwords.
    expect(terms).toMatch(/stor\w+ it encrypted/);
    expect(terms).toMatch(/only to sync and send/);
    expect(terms).toMatch(/delete it when you remove the connection/);
    expect(terms).toMatch(/Privacy policy/);
  });
});
