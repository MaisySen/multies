// Fails when an em dash or en dash appears in source, docs or store copy. House style: none.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["src", "docs", "store", "plugins", "ios-native/Sources", "scripts", "README.md", "AGENTS.md", "app.json", "eas.json", "eslint.config.js", "__tests__"];
const DASHES = ["\u2013", "\u2014"];
const hits = [];
function walk(p) {
  let st;
  try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) { for (const f of readdirSync(p)) walk(join(p, f)); return; }
  if (!/\.(tsx?|mjs|js|json|md|swift)$/.test(p) || p.endsWith("v1.d.ts")) return;
  readFileSync(p, "utf8").split("\n").forEach((line, i) => { if (DASHES.some((d) => line.includes(d))) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 100)}`); });
}
roots.forEach(walk);
if (hits.length) { console.error(`Dashes found (use a comma, colon or full stop):\n${hits.join("\n")}`); process.exit(1); }
console.log("Copy check passed: no em or en dashes.");
