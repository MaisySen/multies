import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isKnownPage } from "../src/shared/known-routes";

// R37: every public page the web router serves must be in the Worker's known pages list
// (src/shared/known-routes.ts), or the Worker answers it with a 404. R36 shipped /developers/mcp
// without it and only the staging sitemap check caught it. This test reads the router itself, so a
// new public route fails here first.
const root = join(__dirname, "..");
const router = readFileSync(join(root, "src/web/router.tsx"), "utf8");

/** Every `path: "..."` in the router, made absolute (child paths under /app get the prefix). */
function routerPaths(): string[] {
  const out: string[] = [];
  const re = /path:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(router))) {
    const p = m[1];
    if (p === "*") continue;
    out.push(p.startsWith("/") ? p : `/app/${p}`);
  }
  return out;
}

/** A sample URL for a route pattern: each :param becomes a plain value. */
const sample = (p: string) => p.replace(/:[A-Za-z]+/g, "sample1");

describe("known routes cover the router (R37)", () => {
  const paths = routerPaths();

  it("finds the router's routes", () => {
    expect(paths.length).toBeGreaterThan(40);
    expect(paths).toContain("/developers/mcp");
    expect(paths).toContain("/pricing");
  });

  it.each(paths)("the Worker knows %s", (p) => {
    expect(isKnownPage(sample(p))).toBe(true);
  });

  it("the sitemap only lists known pages", () => {
    const xml = readFileSync(join(root, "public/sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => new URL(x[1]).pathname);
    expect(locs.length).toBeGreaterThan(3);
    for (const p of locs) expect(isKnownPage(p), p).toBe(true);
  });

  it("still answers 404 for a made up public page", () => {
    expect(isKnownPage("/no-such-page-r37")).toBe(false);
  });
});

// R37 root decision: no AI vendor names in public copy (docs, llms files, landing and pricing).
const VENDORS = /\b(claude|chatgpt|openai|anthropic|openrouter|groq|gemini|copilot|windsurf|mistral|perplexity|deepseek|ollama)\b/i;
const PUBLIC_FILES = [
  "docs/MCP.md",
  "docs/api.md",
  "src/server/generated/llms.generated.ts",
  "src/web/pages/landing.tsx",
  "src/web/pages/pricing.tsx",
  "src/shared/plans.ts",
];

describe("public copy names no AI vendor (R37)", () => {
  it.each(PUBLIC_FILES)("%s", (f) => {
    const text = readFileSync(join(root, f), "utf8");
    const hit = text.match(VENDORS);
    expect(hit?.[0] ?? null, f).toBeNull();
  });
});
