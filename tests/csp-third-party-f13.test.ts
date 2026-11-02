import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeTestApp } from "./helpers";
import { API_CSP, CAMPAIGN_PUBLIC_CSP, appCsp, docsCsp, frameableCsp, snapShareCsp } from "@/server/lib/security-headers";

// F13 (root rule, 01:10 UTC Nov 2): no page policy may name a script source other than our own origin, the inline
// theme script hash or a nonce. No outside script host, no 'unsafe-eval', no 'unsafe-inline' scripts. This reads
// every policy the worker can send (each builder, each served path, every policy written in the source).

const OK = [/^'self'$/, /^'none'$/, /^'sha(256|384|512)-[A-Za-z0-9+/=]+'$/, /^'nonce-[A-Za-z0-9+/=_-]+'$/, /^'wasm-unsafe-eval'$/];

function scriptSources(csp: string): string[] {
  const d = Object.fromEntries(csp.split(";").map((p) => p.trim().split(/\s+/)).filter((p) => p[0]).map(([k, ...v]) => [k.toLowerCase(), v]));
  const out: string[] = [];
  for (const k of ["script-src", "script-src-elem", "script-src-attr"]) if (d[k]) out.push(...d[k]);
  if (!d["script-src"] && !d["script-src-elem"] && d["default-src"]) out.push(...d["default-src"]);
  return out;
}

export function badScriptSources(csp: string): string[] {
  return scriptSources(csp).filter((s) => !OK.some((r) => r.test(s)));
}

describe("F13 page policy: our own scripts only", () => {
  it("the checker catches an outside host, unsafe-eval and unsafe-inline", () => {
    expect(badScriptSources("default-src 'self'; script-src 'self' https://static.cloudflareinsights.com")).toEqual(["https://static.cloudflareinsights.com"]);
    expect(badScriptSources("script-src 'self' 'unsafe-eval'")).toEqual(["'unsafe-eval'"]);
    expect(badScriptSources("script-src 'self' 'unsafe-inline'")).toEqual(["'unsafe-inline'"]);
    expect(badScriptSources("default-src https:")).toEqual(["https:"]);
    expect(badScriptSources("script-src 'self' 'wasm-unsafe-eval' 'sha256-abc='")).toEqual([]);
  });

  it("every policy builder", () => {
    const policies: Record<string, string> = {
      app: appCsp(),
      appFull: appCsp({ appUrl: "https://multies.si", livekitUrl: "wss://lk.example.org", connectSrc: ["https://sentry.example.org"] }),
      anonymous: appCsp({ anonymous: true }),
      framed: frameableCsp(appCsp()),
      docs: docsCsp(),
      snap: snapShareCsp(),
      api: API_CSP,
      campaign: CAMPAIGN_PUBLIC_CSP,
    };
    for (const [name, csp] of Object.entries(policies)) expect({ name, bad: badScriptSources(csp) }).toEqual({ name, bad: [] });
  });

  it("every served page and public path", async () => {
    const { app } = await makeTestApp();
    const paths = ["/", "/app", "/site/demo", "/site/demo/blog", "/site/demo/blog/a-post", "/f/not-a-form", "/f/not-a-form/embed", "/share/snapchat",
      "/api/v1/reference", "/api/v1/reference.js", "/report", "/data-request", "/s/not-a-share", "/sign/x", "/api/campaign-public/confirm/x", "/widget.js", "/forms-embed.js", "/help/x", "/bio/x"];
    let seen = 0;
    for (const p of paths) {
      const res = await app.request(p, { headers: { host: "localhost" } });
      const csp = res.headers.get("content-security-policy");
      if (!csp) continue;
      seen++;
      expect({ p, bad: badScriptSources(csp) }).toEqual({ p, bad: [] });
    }
    expect(seen).toBeGreaterThan(10);
  });

  it("no policy written anywhere in the source names an outside script source", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|mjs|js)$/.test(f)) files.push(p); } };
    walk(join(__dirname, "..", "src"));
    const bad: string[] = [];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      const text = raw.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n"); // code, not comments
      for (const m of text.matchAll(/script-src(?:-elem|-attr)?\s+([^;"`\n]*)/g)) {
        for (const tok of m[1].trim().split(/\s+/).filter(Boolean)) {
          if (tok.startsWith("$") || tok.includes("{")) continue; // a template part; the builders above cover those
          if (!OK.some((r) => r.test(tok))) bad.push(`${f.split("/src/")[1]}: ${tok}`);
        }
      }
      if (/cloudflareinsights|challenges\.cloudflare\.com\/turnstile\/v0\/api\.js|cdn\.jsdelivr\.net/.test(text)) bad.push(`${f.split("/src/")[1]}: outside script url`);
    }
    expect(bad).toEqual([]);
  });
});
