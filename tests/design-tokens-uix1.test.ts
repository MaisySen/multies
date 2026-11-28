import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * UIX1 design system guards (docs/design/design-system.md). Each test pins one rule that was broken on main:
 *  1. A colour utility with no token behind it makes no CSS (text-danger, text-good and bg-canvas did, in 43 places).
 *  2. `dark:` utilities follow the app theme, not only the system setting.
 *  3. The two dark blocks in index.css (the explicit choice and the system setting) carry the same tokens.
 *  4. Animation utilities come from the theme; the plugin style `animate-in fade-in` made no CSS.
 */

const WEB = path.resolve(import.meta.dirname, "../src/web");
const css = readFileSync(path.join(WEB, "index.css"), "utf8");
const des1 = readFileSync(path.join(WEB, "design-des1.css"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const pages = walk(WEB).map((file) => ({ file: path.relative(WEB, file), text: readFileSync(file, "utf8") }));

/** Names declared as --color-<name> in the theme. */
const colourTokens = new Set([...(css + des1).matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));

/** Class strings: quoted or template literals that hold at least one common utility. */
function classStrings(text: string): string[] {
  return [...text.matchAll(/"([^"\n]{3,})"|`([^`\n]{3,})`/g)].map((m) => m[1] ?? m[2]).filter((s) => /(^| )(flex|grid|text-|bg-|px-|py-|rounded|border|h-|w-)/.test(s));
}

describe("colour utilities resolve to a theme token (UIX1)", () => {
  // The words pages reached for that had no token on main. Each must exist now, and stay.
  const SECOND_NAMES = ["danger", "warning", "good", "success", "ink", "canvas", "info"];
  it("declares the status and surface names pages use", () => {
    for (const name of ["bg", "surface", "elevated", "hover", "fill", "line", "line-strong", "fg", "muted", "subtle", "brand", "brand-hover", "brand-soft", "ok", "warn", "bad", ...SECOND_NAMES]) {
      expect(colourTokens.has(name), `--color-${name}`).toBe(true);
    }
  });
  it("the second names point at the first names, so light, dark and brand themes move them together", () => {
    for (const [alias, first] of [["danger", "bad"], ["warning", "warn"], ["good", "ok"], ["success", "ok"], ["ink", "fg"], ["canvas", "bg"]]) {
      expect(css).toContain(`--color-${alias}: var(--color-${first});`);
    }
  });
  it("no page uses a semantic colour word that has no token", () => {
    // Semantic words only: palette colours (red-500), arbitrary values ([#fff]) and non-colour utilities are not this test's business.
    const WORDS = /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|ring|fill|stroke|divide|outline|decoration|caret|from|to|via)-(danger|warning|good|success|ink|canvas|info|error|critical|positive|negative|primary|secondary|foreground|background|selected|surface-2|surface-3|muted-foreground|destructive)(?:\/\d+)?(?![\w-])/g;
    const missing: string[] = [];
    for (const { file, text } of pages) {
      for (const s of classStrings(text)) for (const m of s.matchAll(WORDS)) if (!colourTokens.has(m[1])) missing.push(`${file}: ${m[0]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("dark mode has one rule (UIX1)", () => {
  it("dark: utilities follow data-theme first, then the system setting", () => {
    expect(css).toMatch(/@custom-variant dark \{/);
    expect(css).toContain('&:where([data-theme="dark"], [data-theme="dark"] *) { @slot; }');
    expect(css).toContain('&:where(:root:not([data-theme="light"]), :root:not([data-theme="light"]) *) { @slot; }');
  });
  it("the explicit dark block and the system dark block set the same tokens to the same values, once each", () => {
    const explicit = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1] ?? "";
    const system = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)?.[1] ?? "";
    const decls = (block: string) => block.split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean);
    const a = decls(explicit), b = decls(system);
    expect(a.length).toBeGreaterThan(20);
    expect(new Set(a).size, "a token is set twice in the explicit block").toBe(a.length);
    expect(new Set(b).size, "a token is set twice in the system block").toBe(b.length);
    expect([...b].sort()).toEqual([...a].sort());
  });
  it("every status colour has a dark value", () => {
    const explicit = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)?.[1] ?? "";
    for (const name of ["ok", "ok-soft", "warn", "warn-soft", "bad", "bad-soft", "info", "info-soft"]) expect(explicit, name).toContain(`--color-${name}:`);
  });
});

describe("motion comes from the theme (UIX1)", () => {
  it("no page uses the plugin style animate-in or fade-in utilities, which this build does not have", () => {
    const hits: string[] = [];
    for (const { file, text } of pages) {
      for (const s of classStrings(text)) if (/(^|[\s:])(animate-in|fade-in|slide-in-from-[a-z]+-\d+)(\s|$)/.test(s)) hits.push(file);
    }
    expect([...new Set(hits)]).toEqual([]);
  });
  it("less motion is honoured app wide", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation-duration: 1ms !important;/);
  });
});

describe("base layer covers what every page relies on (UIX1)", () => {
  it("pressable things show the hand, switched off things show that they are", () => {
    expect(css).toMatch(/:where\(button, \[role="button"\][^)]*\) \{ cursor: pointer; \}/);
    expect(css).toMatch(/:disabled, :where\(\[aria-disabled="true"\]\) \{ cursor: not-allowed; \}/);
  });
  it("the focus ring is one token set, and forced colours and more contrast are handled", () => {
    expect(css).toContain(":focus-visible { outline: var(--ring-width) solid var(--ring-color); outline-offset: var(--ring-offset);");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("@media (prefers-contrast: more)");
  });
  it("the page cannot scroll sideways and native controls take the brand colour", () => {
    expect(css).toMatch(/body \{[^}]*overflow-x: clip;/);
    expect(css).toContain("accent-color: var(--color-brand);");
  });
});
