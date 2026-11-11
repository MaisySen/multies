import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * QUAL1 (audit row 10): the web client's api helper already puts "/api" in front of every path, so a caller that passes
 * "/api/..." asks for "/api/api/..." and gets a 404. The PRIV1a privacy notice never loaded on Home because of it.
 * Every helper that adds the prefix itself is listed here; a call to one of them with a path that starts with "/api/"
 * fails this test. The phone's transport adds the prefix the same way (mobile/src/api/transport.ts).
 */
const WEB_PREFIXING = [
  // src/web/lib/api.ts: fetch(`/api${path}`)
  /\bapi\.(?:get|post|put|patch|del)\s*(?:<[^()]*?>)?\(\s*[`"']\/api\//,
  // src/web/pages/app/tools-ai.tsx: uploadForm, postFile and downloadPost fetch `/api${path}` too
  /\b(?:uploadForm|postFile|downloadPost)\s*\(\s*[`"']\/api\//,
  // a hand written doubled prefix anywhere
  /[`"']\/api\/api\//,
];
const PHONE_PREFIXING = [
  // mobile/src/api/transport.ts: `${this.base}/api${path}`
  /\brequest\s*(?:<[^()]*?>)?\(\s*["'][A-Z]+["']\s*,\s*[`"']\/api\//,
  /[`"']\/api\/api\//,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(n) && !/\.d\.ts$/.test(n) ? [p] : [];
  });
}

function offenders(roots: string[], patterns: RegExp[]): string[] {
  const root = process.cwd();
  const out: string[] = [];
  for (const dir of roots) {
    for (const f of files(join(root, dir))) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (patterns.some((p) => p.test(line))) out.push(`${relative(root, f).replace(/\\/g, "/")}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  }
  return out;
}

describe("no doubled /api prefix (QUAL1, audit row 10)", () => {
  it("no web caller passes a path starting with /api/ to a helper that adds /api itself", () => {
    expect(offenders(["src/web"], WEB_PREFIXING)).toEqual([]);
  });

  it("no phone caller passes a path starting with /api/ to the transport", () => {
    expect(offenders(["mobile/src"], PHONE_PREFIXING)).toEqual([]);
  });

  it("the guard itself catches the old privacy call", () => {
    const old = 'return useQuery({ queryKey: MINE_KEY, queryFn: () => api.get<Mine>("/api/mailboxes/privacy/mine"), staleTime: 60_000 });';
    const oldDel = "mutationFn: (id: string) => api.del(`/api/mailboxes/${id}/sharing/${me}`),";
    expect(WEB_PREFIXING.some((p) => p.test(old))).toBe(true);
    expect(WEB_PREFIXING.some((p) => p.test(oldDel))).toBe(true);
    expect(WEB_PREFIXING.some((p) => p.test('api.get<Mine>("/mailboxes/privacy/mine")'))).toBe(false);
    expect(PHONE_PREFIXING.some((p) => p.test('t.request<X>("GET", "/api/counts")'))).toBe(true);
  });

  it("the privacy panel asks for /api/mailboxes/privacy/mine exactly once prefixed", async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => { seen.push(String(url)); return new Response(JSON.stringify({ own: [], shared: [], hiddenFromMe: 0 }), { status: 200 }); }) as typeof fetch;
    try {
      const src = readFileSync(join(process.cwd(), "src/web/components/mailbox-privacy-priv1a.tsx"), "utf8");
      const path = src.match(/api\.get<Mine>\("([^"]+)"\)/)?.[1];
      expect(path).toBe("/mailboxes/privacy/mine");
      const { api } = await import("@/web/lib/api");
      await api.get(path!);
      expect(seen).toEqual(["/api/mailboxes/privacy/mine"]);
    } finally { globalThis.fetch = real; }
  });
});
