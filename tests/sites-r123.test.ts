import { describe, expect, it } from "vitest";
import { BlockError, buttonColour, cleanBlocks, inlineHtml, pageSlugProblem, renderPageHtml, safeImageUrl, safeUrl, siteSlugProblem, statusOf, type Block } from "@/shared/sites";
import { isSitesExcluded, statsFrom } from "@/server/services/sites";

const site = { name: "Acme", brandColor: "#0f766e", logoUrl: null, homeHref: "/site/acme", nav: [] };
const links = { formHref: (s: string) => `/f/${s}`, bookingHref: (s: string) => `/book/${s}` };

describe("R123 block checks", () => {
  it("keeps only known block types and trims fields", () => {
    const b = cleanBlocks([{ type: "heading", text: "  Hello   world ", level: 3 }, { type: "divider" }]);
    expect(b[0]).toMatchObject({ type: "heading", text: "Hello world", level: 3 });
    expect(() => cleanBlocks([{ type: "html", html: "<script>x</script>" }])).toThrow(BlockError);
    expect(() => cleanBlocks("nope")).toThrow(BlockError);
    expect(() => cleanBlocks(Array.from({ length: 61 }, () => ({ type: "divider" })))).toThrow(/60 blocks/);
  });
  it("refuses unsafe link and image targets", () => {
    expect(() => cleanBlocks([{ type: "button", label: "Go", url: "javascript:alert(1)" }])).toThrow(/must start with/);
    expect(() => cleanBlocks([{ type: "image", url: "http://x.test/a.png" }])).toThrow(/https/);
    expect(() => cleanBlocks([{ type: "form", slug: "../../etc" }])).toThrow(/pick a form/);
    expect(safeUrl("data:text/html,hi")).toBeNull();
    expect(safeUrl("//evil.test")).toBeNull();
    expect(safeUrl("/contact")).toBe("/contact");
    expect(safeUrl("mailto:hi@acme.io")).toBe("mailto:hi@acme.io");
    expect(safeImageUrl("https://img.test/a.png")).toBe("https://img.test/a.png");
  });
  it("needs a button address only when there is a label", () => {
    expect(cleanBlocks([{ type: "button", label: "", url: "" }])[0]).toMatchObject({ url: "" });
    expect(() => cleanBlocks([{ type: "button", label: "Go", url: "" }])).toThrow(/add the button address/);
  });
  it("checks addresses", () => {
    expect(pageSlugProblem("about-us")).toBeNull();
    expect(pageSlugProblem("About Us")).not.toBeNull();
    expect(pageSlugProblem("sitemap")).not.toBeNull();
    expect(siteSlugProblem("ac")).not.toBeNull();
    expect(siteSlugProblem("acme-co")).toBeNull();
  });
});

describe("R123 rendering", () => {
  it("escapes everything and only turns bold, italic and safe links into markup", () => {
    const h = inlineHtml('<img src=x onerror=alert(1)> **b** *i* [ok](https://a.test) [bad](javascript:alert(1))');
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img");
    expect(h).toContain("<strong>b</strong>");
    expect(h).toContain("<em>i</em>");
    expect(h).toContain('<a href="https://a.test/" rel="noopener noreferrer">ok</a>');
    expect(h).not.toContain('href="javascript');
  });
  it("renders title, description, og tags, canonical and no script from blocks", () => {
    const blocks = cleanBlocks([{ type: "hero", title: "Hi </title><script>", text: "x", buttonLabel: "Go", buttonUrl: "https://a.test" }, { type: "form", slug: "abc123", title: "Ask" }, { type: "booking", slug: "olive", title: "Book" }]);
    const html = renderPageHtml(site, { title: "Home", blocks, seoTitle: "Welcome", description: "We build things.", image: "https://img.test/og.png", canonical: "https://app.test/site/acme" }, links);
    expect(html).toContain("<title>Welcome | Acme</title>");
    expect(html).toContain('<meta name="description" content="We build things.">');
    expect(html).toContain('<meta property="og:title" content="Welcome">');
    expect(html).toContain('<meta property="og:image" content="https://img.test/og.png">');
    expect(html).toContain('<link rel="canonical" href="https://app.test/site/acme">');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('href="/f/abc123"');
    expect(html).toContain('href="/book/olive"');
    expect(html).toContain("Hi &lt;/title&gt;&lt;script&gt;");
  });
  it("marks the preview noindex and says when a page is empty", () => {
    const html = renderPageHtml(site, { title: "Empty", blocks: [] as Block[] }, links, { preview: true });
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain("This page has no content yet.");
  });
  it("uses the brand colour for buttons only when white text on it is readable", () => {
    expect(buttonColour("#0f766e")).toBe("#0f766e");
    expect(buttonColour("#fde047")).toBe("#18181b");
    expect(buttonColour(null)).toBe("#18181b");
  });
});

describe("R123 schedule, stats and exclusion", () => {
  it("treats a scheduled page as published once its time has come", () => {
    expect(statusOf({ status: "scheduled", publishAt: 1000 }, 999)).toBe("scheduled");
    expect(statusOf({ status: "scheduled", publishAt: 1000 }, 1000)).toBe("published");
    expect(statusOf({ status: "draft", publishAt: null }, 5)).toBe("draft");
  });
  it("adds up counts by day, page, source and device with no visitor data", () => {
    const s = statsFrom([
      { pageId: "p1", day: "2026-11-01", source: "Direct", device: "Phone", views: 3, title: "Home" },
      { pageId: "p2", day: "2026-11-02", source: "google.com", device: "Desktop", views: 2, title: "About" },
    ], "2026-11-01", 2);
    expect(s.total).toBe(5);
    expect(s.days).toEqual([{ day: "2026-11-01", views: 3 }, { day: "2026-11-02", views: 2 }]);
    expect(s.pages[0]).toMatchObject({ id: "p1", views: 3 });
    expect(Object.keys(s)).toEqual(["days", "total", "pages", "sources", "devices"]);
  });
  it("always keeps vv8k out", () => {
    expect(isSitesExcluded({ id: "o1", slug: "vv8k", name: "Client" })).toBe(true);
    expect(isSitesExcluded({ id: "o2", slug: "acme", name: "Acme" }, "other")).toBe(false);
    expect(isSitesExcluded({ id: "o3", slug: "other", name: "Other" }, "other")).toBe(true);
  });
});
