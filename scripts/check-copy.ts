/**
 * Copy lint, run in CI (npm run lint:copy):
 *  1. No em dashes or en dashes anywhere in tracked text files.
 *  2. No stock AI-marketing phrases in user-facing copy (web app, emails, docs).
 *  3. No tab.bot host and no old build mailbox name anywhere (code, config, docs): every Multies address lives on multies.si.
 * The phrase list is shared with Vale (styles/Multies/Slop.yml) so editors flag the same words.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DASHES = /[\u2013\u2014]/;

export const SLOP = [
  "seamless", "seamlessly", "elevate", "elevates", "unlock", "unlocks", "supercharge", "supercharged",
  "effortless", "effortlessly", "robust", "cutting-edge", "cutting edge", "in today's", "game-changer", "game changer",
  "revolutionize", "revolutionary", "leverage", "empower", "empowers", "delve", "best-in-class", "world-class",
  "next-level", "next level", "unleash", "harness the power", "streamline", "streamlined", "blazing fast", "blazing-fast",
  "state-of-the-art", "transform your", "look no further", "embark", "tapestry", "game changing",
];

const SLOP_RE = new RegExp(`\\b(${SLOP.map((w) => w.replace(/[-']/g, (c) => `\\${c}`).replace(/ /g, "\\s+")).join("|")})\\b`, "i");

/** Files whose words reach people: the web app, email templates, docs. */
export function isUserFacing(file: string) {
  return /^(src\/web\/|docs\/|README\.md$|index\.html$|src\/server\/auth\.ts$|src\/server\/services\/(system-mail|demo)\.ts$|src\/server\/services\/dns\/checks\.ts$|src\/server\/services\/mail-check\.ts$|src\/shared\/mail-check\.ts$|src\/shared\/trust\.ts$|src\/shared\/undo-send\.ts$|mail-server\/)/.test(file);
}

/** The product's old name. People see "Multies"; internal names (the worker, hosts, headers) are not prose. */
const OLD_NAME = /\bMy ?Mail\b(?![-/])|\bMail ?Forge\b/;

/** Hosts and the old build mailbox name that must never ship: Multies lives on multies.si only. */
export const FOREIGN_HOST = /\btab\.bot\b|\bmymail\.builder\b/i;

/**
 * A quoted dotted id such as "users.unlock" (a permission, an audit action): code, not copy. It is taken out of the
 * line before the stock phrase check, so a permission named after its verb is not read as marketing.
 */
const ID_LITERAL = /(["'`])[a-z][a-z_]*\.[a-z][a-z_]*\1/g;

export interface Issue { file: string; line: number; rule: "dash" | "slop" | "name" | "host"; text: string }

export function findIssues(file: string, text: string): Issue[] {
  const out: Issue[] = [];
  const facing = isUserFacing(file);
  text.split("\n").forEach((line, i) => {
    // nosemgrep: regex_dos (a fixed two-character class, linear time)
    if (DASHES.test(line)) out.push({ file, line: i + 1, rule: "dash", text: line.trim() });
    const m = facing ? line.replace(ID_LITERAL, "").match(SLOP_RE) : null;
    if (m) out.push({ file, line: i + 1, rule: "slop", text: m[0] });
    if (facing && OLD_NAME.test(line)) out.push({ file, line: i + 1, rule: "name", text: line.match(OLD_NAME)?.[0] ?? "old name" });
    if (FOREIGN_HOST.test(line)) out.push({ file, line: i + 1, rule: "host", text: line.trim() });
  });
  return out;
}

const SKIP = /(^|\/)(package-lock\.json|scripts\/check-copy\.ts|tests\/copy-lint\.test\.ts|styles\/Multies\/Slop\.yml)$|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip)$/i;

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = execSync("git ls-files -co --exclude-standard", { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f && !SKIP.test(f));
  const issues = files.flatMap((f) => {
    try { return findIssues(f, readFileSync(path.join(root, f), "utf8")); } catch { return []; }
  });
  for (const i of issues) {
    const why = i.rule === "dash" ? "em/en dash: use a period, comma or colon"
      : i.rule === "host" ? "tab.bot address or old build mailbox: use the multies.si equivalent"
      : `stock phrase "${i.text}": say the concrete thing`;
    console.error(`${i.file}:${i.line}  ${why}  ${i.rule === "dash" || i.rule === "host" ? i.text.slice(0, 120) : ""}`);
  }
  if (issues.length) {
    console.error(`\n${issues.length} copy issue(s).`);
    process.exit(1);
  }
  console.log(`copy lint: ${files.length} files clean`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
