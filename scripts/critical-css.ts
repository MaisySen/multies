/**
 * R34 (perf2): the CSS one page needs, cut from the built stylesheet. Keeps every rule whose selector names only
 * classes the page's HTML uses (element, :root and attribute selectors are kept as they are), every at-rule that
 * still holds a kept rule, and the @property and @font-face rules (the theme's typed variables and the fallback
 * fonts). The result is inlined into the sign in shell, so the card paints from the HTML before the main
 * stylesheet (non-blocking there) has arrived. Same rules, same order, same layers, so nothing restyles later.
 */
import postcss, { type AtRule, type Container, type Rule } from "postcss";

/** Every class name used in the HTML (class="..." attributes). */
export function classesIn(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sclass="([^"]*)"/g)) for (const c of m[1].replace(/&amp;/g, "&").split(/\s+/)) if (c) out.add(c);
  return out;
}

/** The class names a selector needs, unescaped (".hover\:underline" is "hover:underline"). */
export function selectorClasses(selector: string): string[] {
  const out: string[] = [];
  for (const m of selector.matchAll(/\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[\w-])+)/g)) {
    out.push(m[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_s, hex: string) => String.fromCodePoint(parseInt(hex, 16))).replace(/\\(.)/g, "$1"));
  }
  return out;
}

const KEEP_AT = new Set(["property", "font-face"]);

function prune(node: Container, used: Set<string>): void {
  node.each((child) => {
    if (child.type === "rule") {
      const rule = child as Rule;
      // Keyframes steps (from, to, 50%) live inside @keyframes, which is handled below.
      const kept = rule.selectors.filter((s) => selectorClasses(s).every((c) => used.has(c)));
      if (!kept.length) rule.remove();
      else if (kept.length !== rule.selectors.length) rule.selectors = kept;
      if (rule.parent && rule.nodes?.some((n) => n.type === "rule" || n.type === "atrule")) prune(rule, used);
    } else if (child.type === "atrule") {
      const at = child as AtRule;
      if (KEEP_AT.has(at.name)) return;
      if (at.name === "keyframes") { if (!usedKeyframes(at.params, used)) at.remove(); return; }
      if (at.nodes) {
        prune(at, used);
        if (!at.nodes.length) at.remove();
      } else if (at.name !== "layer" && at.name !== "charset") at.remove();
    }
  });
}

/** Keyframes are kept when a used class names them (animate-spin keeps spin). */
function usedKeyframes(name: string, used: Set<string>): boolean {
  return [...used].some((c) => c === `animate-${name}` || c.endsWith(`:animate-${name}`));
}

export function criticalCss(css: string, htmls: string[]): string {
  const used = new Set<string>();
  for (const h of htmls) for (const c of classesIn(h)) used.add(c);
  const root = postcss.parse(css);
  prune(root, used);
  return root.toString().replace(/\n\s*\n/g, "\n");
}
