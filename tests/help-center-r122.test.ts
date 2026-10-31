import { describe, it, expect } from "vitest";
import {
  centerSlugProblem, cleanPost, freeSlug, helpfulPercent, looksLikeSpam, nameParts, pageOf, prefixEnd, queryTerms, redactForPublic, slugify, stillPrivate, termsOf, words,
} from "@/shared/help-center";

/** R122: the help center's pure rules. */
describe("addresses", () => {
  it("slugifies titles, folds accents and never returns empty", () => {
    expect(slugify("Getting started: Billing!")).toBe("getting-started-billing");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("!!!")).toBe("page");
    expect(slugify("a".repeat(100)).length).toBeLessThanOrEqual(60);
  });
  it("picks a free slug", () => {
    expect(freeSlug("faq", [])).toBe("faq");
    expect(freeSlug("faq", ["faq", "faq-2"])).toBe("faq-3");
  });
  it("checks help center addresses", () => {
    expect(centerSlugProblem("acme-help")).toBeNull();
    expect(centerSlugProblem("ab")).toMatch(/3 to 60/);
    expect(centerSlugProblem("Acme")).toMatch(/lowercase/);
    expect(centerSlugProblem("api")).toMatch(/taken/);
    expect(centerSlugProblem("a--b-")).not.toBeNull();
  });
  it("reads a page number in range", () => {
    expect(pageOf("3")).toBe(3);
    expect(pageOf("0")).toBe(1);
    expect(pageOf("abc")).toBe(1);
    expect(pageOf("999")).toBe(1);
    expect(pageOf(undefined)).toBe(1);
  });
});

describe("search terms", () => {
  it("drops stop words and short words, folds case and accents", () => {
    expect(words("How do I reset the Pässword?")).toEqual(["reset", "password"]);
  });
  it("weights title over summary over body and caps terms", () => {
    const t = termsOf({ title: "Refund policy", summary: "refund rules", body: "policy policy money" });
    const w = Object.fromEntries(t.map((x) => [x.term, x.weight]));
    expect(w.refund).toBe(8);
    expect(w.policy).toBe(7);
    expect(w.money).toBe(1);
    const many = termsOf({ title: "x", body: Array.from({ length: 500 }, (_, i) => `word${i}`).join(" ") });
    expect(many.length).toBe(200);
  });
  it("keeps at most 6 distinct query words; the prefix range is exclusive", () => {
    expect(queryTerms("one two three four five six seven eight one")).toEqual(["one", "two", "three", "four", "five", "six"]);
    expect(prefixEnd("bill")).toBe("bilm");
    const word = "billing";
    expect(word >= "bill" && word < prefixEnd("bill")).toBe(true);
    expect("bilm" < prefixEnd("bill")).toBe(false);
  });
});

describe("redaction of a solved ticket", () => {
  const bits = { names: ["Grace Hopper"], emails: ["grace@example.com"] };
  it("removes addresses, phone numbers and the customer's name; keeps the greeting", () => {
    const r = redactForPublic("Hi Grace, I am Grace Hopper (grace@example.com, +61 400 123 456). Order 1234 is late.", bits);
    expect(r.text).toBe("Hi, I am the customer ([email removed], [phone removed]). Order 1234 is late.");
    expect(r.removed).toMatchObject({ emails: 1, phones: 1 });
    expect(r.removed.names).toBeGreaterThan(0);
  });
  it("keeps short numbers like order numbers and years", () => {
    expect(redactForPublic("Order 12345 from 2026", bits).text).toBe("Order 12345 from 2026");
  });
  it("cuts quoted history and signatures", () => {
    const r = redactForPublic("Use the link.\n\nOn Mon, 3 Nov 2026 Grace Hopper <grace@example.com> wrote:\n> my old question\n> more", bits);
    expect(r.text).toBe("Use the link.");
    expect(r.removed.quoted).toBeGreaterThan(0);
    expect(redactForPublic("Thanks\n-- \nGrace Hopper\nCEO", bits).text).toBe("Thanks");
    expect(redactForPublic("Reply\n> quoted line\nAfter", bits).text).toBe("Reply\nAfter");
  });
  it("does not touch words that only contain the name", () => {
    expect(redactForPublic("Graceful shutdown", bits).text).toBe("Graceful shutdown");
  });
  it("tells when text still names the customer", () => {
    expect(stillPrivate("Grace asked about refunds", bits)).toBe(true);
    expect(stillPrivate("write to GRACE@example.com", bits)).toBe(true);
    expect(stillPrivate("Graceful refunds", bits)).toBe(false);
    expect(stillPrivate("The customer asked", bits)).toBe(false);
  });
  it("name parts skip emails and one letter parts", () => {
    expect(nameParts(["Grace B Hopper", "x@y.io"])).toEqual(["Grace B Hopper", "Hopper", "Grace"]);
  });
});

describe("public posts", () => {
  it("cleans control characters and caps length", () => {
    expect(cleanPost("  hi\u0000 there \n\n\n\nok ", 100)).toBe("hi there\n\nok");
    expect(cleanPost(42, 10)).toBe("");
    expect(cleanPost("x".repeat(50), 10)).toHaveLength(10);
  });
  it("holds link farms and shouting", () => {
    expect(looksLikeSpam("see http://a http://b http://c")).toBe(true);
    expect(looksLikeSpam("THIS IS A VERY LOUD MESSAGE FOR EVERYONE HERE")).toBe(true);
    expect(looksLikeSpam("How do I export my data to CSV?")).toBe(false);
  });
  it("gives a helpful percent only with votes", () => {
    expect(helpfulPercent(0, 0)).toBeNull();
    expect(helpfulPercent(3, 1)).toBe(75);
  });
});
