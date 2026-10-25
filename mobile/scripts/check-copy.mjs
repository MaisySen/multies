// Fails when an em dash or en dash appears in source, docs or store copy (house style: none),
// or when any address on the old preview domain appears: Multies lives on multies.si only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["src", "docs", "store", "plugins", "ios-native/Sources", "scripts", "README.md", "AGENTS.md", "app.json", "eas.json", "eslint.config.js", "__tests__"];
const DASHES = ["\u2013", "\u2014"];
const HOST = /\btab\.bot\b/i;
const hits = [];
function walk(p) {
  let st;
  try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); return; }
  if (!/\.(tsx?|mjs|js|json|md|swift)$/.test(p) || p.endsWith("v1.d.ts")) return;
  readFileSync(p, "utf8").split("\n").forEach((line, i) => { if (DASHES.some((d) => line.includes(d)) || HOST.test(line)) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 100)}`); });
}
roots.forEach(walk);
if (hits.length) { console.error(`Dashes or old preview hosts found (use a comma, colon or full stop; use multies.si addresses):\n${hits.join("\n")}`); process.exit(1); }
console.log("Copy check passed: no em or en dashes, no old preview hosts.");
