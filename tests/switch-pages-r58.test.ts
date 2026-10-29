import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SWITCH_SOURCES, importPathFor, sampleFileName, startImportHref, switchSource } from "../src/shared/switch-sources";
import { readTable } from "../src/server/services/work-import/parse";
import { isKnownPage } from "../src/shared/known-routes";
import { PUBLIC_META, metaFor } from "../src/web/components/seo-meta";
import { signInDestination } from "../src/web/lib/pending-invite";

/** R58 (MB-237): switch pages exist only for tools the import reads, each sample really imports, and search engines find them. */
describe("switch pages (R58 MB-237)", () => {
  it("each sample file is read by the import as its own tool", () => {
    for (const s of SWITCH_SOURCES) {
      const text = readFileSync(`public${s.sample}`, "utf8");
      const t = readTable(text, s.sample.split("/").pop());
      expect(t.source, s.slug).toBe(s.slug);
      expect(t.rows.length, s.slug).toBeGreaterThanOrEqual(3);
      expect(text, s.slug).not.toMatch(/acme\.io|\.test\b/); // made up addresses only (example.com and friends)
    }
  });

  it("every switch page is a tool in the import picker", () => {
    const picker = readFileSync("src/web/pages/app/data-move.tsx", "utf8");
    for (const s of SWITCH_SOURCES) expect(picker, s.slug).toMatch(new RegExp(`\\{ id: "${s.slug}", kind: "tasks"`));
  });

  it("the import button lands on the import screen, after sign up when signed out", () => {
    expect(startImportHref("trello", true)).toBe("/app/settings/import?source=trello");
    const out = startImportHref("trello", false);
    expect(out).toBe(`/signup?next=${encodeURIComponent("/app/settings/import?source=trello")}`);
    const next = new URLSearchParams(out.split("?")[1]).get("next");
    expect(signInDestination(next, "/app")).toBe(importPathFor("trello"));
    expect(sampleFileName(switchSource("trello")!)).toBe("trello-board-sample.json");
    expect(switchSource("nope")).toBeNull();
  });

  it("routes, 404s, titles and the sitemap know every page", () => {
    const sitemap = readFileSync("public/sitemap.xml", "utf8");
    const paths = ["/startups", "/switch", ...SWITCH_SOURCES.map((s) => `/switch/${s.slug}`)];
    for (const p of paths) {
      expect(isKnownPage(p), p).toBe(true);
      expect(sitemap, p).toContain(`<loc>https://multies.si${p}</loc>`);
      expect(PUBLIC_META[p]?.noindex, p).toBeUndefined();
      expect(metaFor(p).title, p).toMatch(/\| Multies$/);
    }
    expect(isKnownPage("/switch/nope")).toBe(false);
    expect(isKnownPage("/switch/trello/x")).toBe(false);
    const titles = paths.map((p) => PUBLIC_META[p].title);
    expect(new Set(titles).size).toBe(titles.length);
    const robots = readFileSync("public/robots.txt", "utf8");
    expect(robots).not.toMatch(/Disallow: \/(switch|startups)/);
  });
});
