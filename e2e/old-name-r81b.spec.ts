import { test, expect, type APIRequestContext } from "@playwright/test";
import { SITE_URL } from "../src/web/components/seo-meta";

/**
 * R81B: the product is Multies. Nothing a person, a search engine or an API client can read may say the old
 * names. This walks every public page in sitemap.xml, the machine readable files (robots, llms, OpenAPI, the docs
 * pages) and every script and style the pages load, including the chunks those load later, and fails on any match.
 * Public GETs only, so it also runs against staging and production:
 *   E2E_ALLOW_REMOTE=1 E2E_BASE_URL=https://multies.si npx playwright test e2e/old-name-r81b.spec.ts --grep "old name"
 */
export const OLD_NAME = /my ?mail|mail ?forge/i;

/**
 * Internal names that sit in shipped code but are never shown, each with its reason. Anything else fails.
 * - x-mymail-signature, x-mymail-key: header names between the inbound mail worker and the API, listed so error
 *   reports never carry their values. Renaming them needs a coordinated worker deploy.
 * - mymail-theme: the old saved light or dark choice, read once so it carries over. Remove after 30 Nov 2026.
 */
export const ALLOWED = [/x-mymail-(signature|key)/gi, /"mymail-theme"|`mymail-theme`|'mymail-theme'/g];

export function oldNameHits(text: string): string[] {
  let clean = text;
  for (const a of ALLOWED) clean = clean.replace(a, "");
  const hits: string[] = [];
  const re = new RegExp(OLD_NAME.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) && hits.length < 5) hits.push(clean.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, " "));
  return hits;
}

const MACHINE = ["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/api/v1/openapi.json", "/docs/api.md", "/docs/mcp.md", "/developers/mcp.md", "/legacy.js", "/theme.js", "/sw.js"];
const EXTRA = ["/developers", "/security", "/startups", "/delete-account", "/login", "/signup"];

async function sitemapPaths(request: APIRequestContext) {
  const xml = await (await request.get("/sitemap.xml")).text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].slice(SITE_URL.length) || "/");
  return [...new Set([...locs, ...EXTRA])];
}

test("no old name on any public page, file or bundle", async ({ request }) => {
  test.setTimeout(180_000);
  const pages = await sitemapPaths(request);
  expect(pages.length).toBeGreaterThan(20);
  const problems: string[] = [];
  const assets = new Set<string>();
  const queue: string[] = [];
  const addAssets = (text: string) => {
    for (const m of text.matchAll(/(?:\/|\b)(assets\/[\w.-]+\.(?:js|css))/g)) {
      const a = `/${m[1]}`;
      if (!assets.has(a)) { assets.add(a); queue.push(a); }
    }
  };
  for (const p of [...pages, ...MACHINE]) {
    const res = await request.get(p);
    if (res.status() === 404 && MACHINE.includes(p)) continue;
    const text = await res.text();
    for (const h of oldNameHits(text)) problems.push(`${p}: ${h}`);
    if (!MACHINE.includes(p) || p === "/sw.js") addAssets(text);
  }
  while (queue.length && assets.size < 600) {
    const a = queue.shift()!;
    const res = await request.get(a);
    if (res.status() !== 200) { problems.push(`${a}: status ${res.status()}`); continue; }
    const text = await res.text();
    for (const h of oldNameHits(text)) problems.push(`${a}: ${h}`);
    if (a.endsWith(".js")) addAssets(text);
  }
  expect(assets.size, "found the app bundle").toBeGreaterThan(5);
  expect(problems, problems.join("\n")).toEqual([]);
});

test("no old name in the page titles, headers or the app manifest", async ({ request }) => {
  const res = await request.get("/");
  const headers = Object.entries(res.headers()).map(([k, v]) => `${k}: ${v}`).join("\n");
  expect(oldNameHits(headers), headers).toEqual([]);
  const html = await res.text();
  expect(html).toMatch(/<title>[^<]*Multies/);
  for (const m of ["/manifest.webmanifest", "/site.webmanifest"]) {
    const r = await request.get(m);
    if (r.status() === 200) expect(oldNameHits(await r.text())).toEqual([]);
  }
});

test("old name detector: finds every spelling and skips only the listed internal names", () => {
  expect(oldNameHits("Welcome to MyMail")).toHaveLength(1);
  expect(oldNameHits("Where is my mail stored?")).toHaveLength(1);
  expect(oldNameHits("Built on MailForge")).toHaveLength(1);
  expect(oldNameHits("Bearer $MYMAIL_KEY")).toHaveLength(1);
  expect(oldNameHits("x-mymail-signature|x-mymail-key|localStorage.getItem(\"mymail-theme\")")).toHaveLength(0);
  expect(oldNameHits("Multies, email on your own domain")).toHaveLength(0);
});
