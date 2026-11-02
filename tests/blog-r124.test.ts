import { describe, it, expect } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import {
  autoExcerpt, cleanTags, csvCell, docImageId, freePostSlug, pageNumber, postSlugProblem, postStatusOf, publicImage, readingMinutes, rssXml, scheduleProblem, tagSlug,
  postCardsHtml, subscribeBoxHtml,
} from "@/shared/blog-r124";
import { snapshotHtml, newsletterProblems } from "@/server/services/blog-r124";

/** R124: the blog's pure rules. */
describe("R124 post addresses", () => {
  it("checks addresses and keeps the blog's own words free", () => {
    expect(postSlugProblem("hello-world")).toBeNull();
    expect(postSlugProblem("")).toMatch(/address/);
    expect(postSlugProblem("Hello")).toMatch(/lowercase/);
    expect(postSlugProblem("a--b")).toMatch(/lowercase/);
    expect(postSlugProblem("-a")).toMatch(/lowercase/);
    for (const r of ["tag", "author", "rss", "page", "subscribe", "img"]) expect(postSlugProblem(r)).toMatch(/taken/);
  });
  it("finds the next free address", () => {
    expect(freePostSlug("Hello World!", [])).toBe("hello-world");
    expect(freePostSlug("Hello World", ["hello-world", "hello-world-2"])).toBe("hello-world-3");
    expect(freePostSlug("Tag", [])).toBe("tag-post");
    expect(freePostSlug("", [])).toBe("post");
    expect(freePostSlug("x".repeat(200), []).length).toBeLessThanOrEqual(70);
    expect(postSlugProblem(freePostSlug("x".repeat(200), []))).toBeNull();
  });
});

describe("R124 tags", () => {
  it("cleans, dedupes by address and caps tags", () => {
    expect(cleanTags(["News", "news", "  Product   updates ", "", 3, null])).toEqual(["News", "Product updates"]);
    expect(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(10);
    expect(cleanTags(["a".repeat(100)])[0]).toHaveLength(40);
    expect(cleanTags("nope")).toEqual([]);
    expect(tagSlug("Product updates!")).toBe("product-updates");
    expect(tagSlug("Café Ünïcode")).toBe("café-ünïcode");
  });
});

describe("R124 status and schedule", () => {
  const now = Date.UTC(2026, 10, 1, 12);
  it("reads draft, scheduled and published", () => {
    expect(postStatusOf({ live: null, publishAt: null }, now)).toBe("draft");
    expect(postStatusOf({ live: "{}", publishAt: now + 1 }, now)).toBe("scheduled");
    expect(postStatusOf({ live: "{}", publishAt: now }, now)).toBe("published");
    expect(postStatusOf({ live: null, publishAt: now + 1 }, now)).toBe("draft");
  });
  it("takes an exact instant, so a Sydney time and a UTC time are the same moment", () => {
    const sydney = Date.parse("2026-11-03T09:00:00+11:00");
    const utc = Date.parse("2026-11-02T22:00:00Z");
    expect(sydney).toBe(utc);
    expect(scheduleProblem(sydney, now)).toBeNull();
    expect(scheduleProblem(null, now)).toBeNull();
    expect(scheduleProblem(now - 120_000, now)).toMatch(/future/);
    expect(scheduleProblem(now - 30_000, now)).toBeNull(); // a few seconds of clock drift is fine
    expect(scheduleProblem(now + 400 * 86_400_000, now)).toMatch(/year/);
    expect(scheduleProblem(Number.NaN, now)).toMatch(/date/);
  });
});

describe("R124 reading time and excerpts", () => {
  it("counts about 220 words a minute, at least one", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes("word ".repeat(220))).toBe(1);
    expect(readingMinutes("word ".repeat(1100))).toBe(5);
  });
  it("cuts an excerpt at a word", () => {
    expect(autoExcerpt("Short.")).toBe("Short.");
    const e = autoExcerpt("This sentence is fine. ".repeat(20), 60);
    expect(e.length).toBeLessThanOrEqual(64);
    expect(e.endsWith("...")).toBe(true);
  });
});

describe("R124 images", () => {
  it("serves uploads through the blog and only https links", () => {
    expect(docImageId("/api/doc-images/dim_abcdef12")).toBe("dim_abcdef12");
    expect(docImageId("/api/doc-images/../x")).toBeNull();
    expect(publicImage("/api/doc-images/dim_abcdef12", "https://a.test/site/x/blog")).toBe("https://a.test/site/x/blog/img/dim_abcdef12");
    expect(publicImage("https://img.test/a.png", "b")).toBe("https://img.test/a.png");
    expect(publicImage("http://img.test/a.png", "b")).toBeNull();
    expect(publicImage("javascript:alert(1)", "b")).toBeNull();
    expect(publicImage('https://x.test/"onerror=', "b")).toBeNull();
  });
  it("snapshots a doc with escaped text and uploaded images on the blog's address", () => {
    const doc = { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script>" }] },
      { type: "image", attrs: { src: "/api/doc-images/dim_abcdef12", alt: "A cat" } },
      { type: "image", attrs: { src: "/api/files/private/1", alt: "Hidden" } },
    ] };
    const r = snapshotHtml(doc, "https://a.test/site/acme/blog", "https://a.test");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain('src="https://a.test/site/acme/blog/img/dim_abcdef12"');
    expect(r.html).not.toContain("/api/files/private");
    expect(r.images).toEqual(["dim_abcdef12"]);
  });
});

describe("R124 RSS 2.0", () => {
  it("is well formed, escaped and absolute", () => {
    const xml = rssXml({ title: "News & notes", description: "", link: "https://a.test/site/acme/blog", self: "https://a.test/site/acme/blog/rss.xml", updated: Date.UTC(2026, 10, 1) }, [
      { title: "A <b> & \u0001 'c'", url: "https://a.test/site/acme/blog/a", excerpt: "x < y", publishedAt: Date.UTC(2026, 10, 1), author: "Olive", tags: ["Tips & tricks"], cover: "https://a.test/c.png" },
    ]);
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('<atom:link href="https://a.test/site/acme/blog/rss.xml" rel="self" type="application/rss+xml"/>');
    expect(xml).toContain("<pubDate>Sun, 01 Nov 2026 00:00:00 GMT</pubDate>");
    expect(xml).toContain("<description>News &amp; notes</description>"); // falls back to the title
    expect(xml).toContain("A &lt;b&gt; &amp;  &apos;c&apos;");
    expect(xml).toContain('<guid isPermaLink="true">https://a.test/site/acme/blog/a</guid>');
  });
  it("caps the feed at 20 items", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, url: `https://a.test/${i}`, excerpt: "", publishedAt: i, tags: [] }));
    expect(rssXml({ title: "t", description: "d", link: "https://a.test", self: "https://a.test/rss.xml", updated: null }, items).match(/<item>/g)).toHaveLength(20);
  });
});

describe("R124 public HTML pieces", () => {
  it("escapes post cards and the subscribe box, with a labelled field", () => {
    const h = postCardsHtml([{ slug: "a", title: "<i>x</i>", excerpt: "e", cover: null, tags: ["T"], authorName: "O", authorSlug: "o", publishedAt: 0, readMins: 2 }], "https://a.test/b", "none");
    expect(h).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(h).toContain("2 min read");
    expect(postCardsHtml([], "b", "Nothing yet")).toContain("Nothing yet");
    const box = subscribeBoxHtml({ action: "/s", shield: "/sh", blogTitle: "B", senderName: '"><img>' });
    expect(box).toContain('<label class="visually-hidden" for="sub-email">Email address</label>');
    expect(box).not.toContain('"><img>');
  });
  it("reads page numbers safely", () => {
    expect(pageNumber(undefined, 3)).toBe(1);
    expect(pageNumber("2", 3)).toBe(2);
    expect(pageNumber("99", 3)).toBe(3);
    expect(pageNumber("-1", 3)).toBe(1);
    expect(pageNumber("abc", 0)).toBe(1);
  });
});

describe("R124 subscriber export and newsletter checks", () => {
  it("quotes CSV cells and defuses formulas", () => {
    expect(csvCell("a@b.io")).toBe('"a@b.io"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+61")).toBe(`"'+61"`);
  });
  it("asks for the mailbox, sender and contact address the law needs", () => {
    expect(newsletterProblems({ mailbox_id: null, sender_name: "", sender_address: "" })).toHaveLength(3);
    expect(newsletterProblems({ mailbox_id: "m", sender_name: "Acme", sender_address: "1 George St" })).toEqual([]);
  });
});
