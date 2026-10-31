/**
 * R76: /developers/mcp shipped in R36 with no entry in seo-meta.ts, so every visitor, search engine and link preview
 * saw "Page not found | Multies" (and noindex) on a page that worked. These checks tie the router, the 404 list, the
 * titles, the sitemap and the footer together so a new page cannot ship half wired again.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isKnownPage, KNOWN_PAGE_PATHS } from "../src/shared/known-routes";
import { metaFor, NOT_FOUND_META, PUBLIC_META } from "../src/web/components/seo-meta";
import { WEBHOOK_EVENT_GROUPS } from "../src/shared/developer-hub";
import { WEBHOOK_EVENTS } from "../src/server/services/developer/webhooks";

const sitemap = readFileSync("public/sitemap.xml", "utf8");
const sitemapPaths = [...sitemap.matchAll(/<loc>https:\/\/multies\.si([^<]*)<\/loc>/g)].map((m) => m[1] || "/");
const router = readFileSync("src/web/router.tsx", "utf8");
const marketing = readFileSync("src/web/layouts/marketing.tsx", "utf8");
// Pages that are known (a 200) but are not public pages with their own title: the guest view and the OAuth consent page.
const NO_OWN_TITLE = new Set(["/guest", "/oauth/authorize"]);

describe("R76 public pages are fully wired", () => {
  it("every sitemap page is a known page with its own indexable title", () => {
    expect(sitemapPaths.length).toBeGreaterThan(20);
    for (const p of sitemapPaths) {
      expect(isKnownPage(p), p).toBe(true);
      const m = metaFor(p);
      expect(m, p).not.toBe(NOT_FOUND_META);
      expect(m.title, p).not.toMatch(/not found/i);
      expect(m.noindex ?? false, p).toBe(false);
    }
  });

  it("every exact known page has its own title (the R36 gap)", () => {
    for (const p of KNOWN_PAGE_PATHS) {
      if (NO_OWN_TITLE.has(p)) continue;
      expect(PUBLIC_META[p], `seo-meta.ts has no entry for ${p}`).toBeTruthy();
    }
  });

  it("every public route in the router is a known page", () => {
    const paths = [...router.matchAll(/\{ path: "(\/[^"]*)"/g)].map((m) => m[1]).filter((p) => !p.includes(":"));
    expect(paths).toContain("/developers");
    expect(paths).toContain("/developers/mcp");
    for (const p of paths) expect(isKnownPage(p), p).toBe(true);
  });

  it("every footer and header link goes to a known page", () => {
    const links = [...marketing.matchAll(/to(?:=|: )"(\/[^"#]*)/g)].map((m) => m[1] || "/");
    expect(links).toContain("/developers");
    for (const p of links) expect(isKnownPage(p), p).toBe(true);
  });

  it("unknown paths are not known pages, so the server answers 404", () => {
    for (const p of ["/developers/api", "/developers/nope", "/blog", "/help", "/pricing/x"]) expect(isKnownPage(p), p).toBe(false);
    expect(metaFor("/blog")).toBe(NOT_FOUND_META);
  });

  it("the developer hub lists exactly the webhook events the server sends", () => {
    const shown = WEBHOOK_EVENT_GROUPS.flatMap((g) => g.events);
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });
});
