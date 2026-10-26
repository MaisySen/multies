import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_SCRIPT, THEME_SCRIPT_HASH, appCsp } from "@/server/lib/security-headers";

const hashOf = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
const inlineScripts = (html: string) => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());

describe("R31 inline theme script", () => {
  it("the CSP hash is the hash of the script's exact bytes", () => {
    expect(hashOf(THEME_SCRIPT)).toBe(THEME_SCRIPT_HASH);
    expect(appCsp()).toContain(`script-src 'self' ${THEME_SCRIPT_HASH}`);
    expect(appCsp()).not.toContain("'unsafe-inline' ;");
    expect(appCsp().split(";").find((d) => d.trim().startsWith("script-src"))).not.toContain("unsafe-inline");
  });

  it("index.html carries it inline before any other script, and no other inline script", () => {
    const html = readFileSync("index.html", "utf8");
    expect(inlineScripts(html)).toEqual([THEME_SCRIPT]);
    expect(html.indexOf(THEME_SCRIPT)).toBeLessThan(html.indexOf("<script src="));
    expect(html).not.toContain('src="/theme.js"');
  });

  it("every built shell (index, landing, sign in) has only inline scripts the CSP allows", () => {
    const shells = ["dist/web/index.html", "dist/web/landing.html", "dist/web/auth.html"].filter((f) => existsSync(f));
    for (const f of shells) {
      const scripts = inlineScripts(readFileSync(f, "utf8"));
      expect(scripts, f).toContain(THEME_SCRIPT);
      for (const s of scripts) expect(appCsp(), `${f}: ${s.slice(0, 40)}`).toContain(hashOf(s));
    }
  });

  it("still does what theme.js did: a saved light or dark choice is applied, anything else is ignored", () => {
    for (const [saved, want] of [["dark", "dark"], ["light", "light"], ["system", undefined], [null, undefined]] as const) {
      const doc = { documentElement: { dataset: {} as Record<string, string> } };
      const storage = { getItem: () => saved };
      new Function("localStorage", "document", THEME_SCRIPT)(storage, doc);
      expect(doc.documentElement.dataset.theme).toBe(want);
    }
    const doc = { documentElement: { dataset: {} as Record<string, string> } };
    expect(() => new Function("localStorage", "document", THEME_SCRIPT)({ getItem: () => { throw new Error("blocked"); } }, doc)).not.toThrow();
  });
});
