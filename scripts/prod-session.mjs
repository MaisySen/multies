#!/usr/bin/env node
/**
 * R45: the PRODUCTION test session, so a UI change can be clicked through on live while the public demo is paused.
 * App side only (nothing at the identity provider). The worker mints the session itself (POST /api/_test-session,
 * src/server/routes/test-session-r45.ts) because the production app secret lives only in the worker.
 *
 *   C="node scripts/creds.mjs run CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID --"
 *   $C node scripts/prod-session.mjs --setup   # once: test user + workspace rows, a new random token, worker secrets
 *   node scripts/prod-session.mjs              # mint a 24 hour session -> ~/.multies-secrets/prod-test-session.json
 *   node scripts/prod-session.mjs --seed       # mint, then (once) a "Windowing check" project, 90 tasks, one sprint
 *   $C node scripts/prod-session.mjs --off     # delete the token secret: the endpoint is a plain 404 again
 *
 * Scope: the user (Prod QA, the build team's prodqa plus address) belongs to exactly one workspace, "Multies QA (test)",
 * a normal non demo workspace with no domain and no mailbox; the worker refuses to mint otherwise. Each mint replaces
 * the last test session. Every mint is in the workspace's audit log. The token and the cookie are written to mode 600
 * files under ~/.multies-secrets and never printed; secrets reach wrangler through a mode 600 file, never argv.
 * It checks /api/health D1 reads first and refuses at 50% or more of the daily budget.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DB = "mymail-au";
const BASE = process.env.PROD_BASE ?? "https://multies.si";
// Semgrep (QUAL1): row ids of the production QA account, not credentials.
export const USER_ID = "usr_prodqa45a1b2c3", ORG_ID = "org_prodqa45a1b2c3", MEMBER_ID = "mem_prodqa45a1b2c3"; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username
// The test user's address lives in the database row (made once); a fresh setup reads it from PROD_QA_EMAIL.
const EMAIL = process.env.PROD_QA_EMAIL ?? "prodqa@example.com";
const DIR = path.join(os.homedir(), ".multies-secrets");
const TOKEN_FILE = path.join(DIR, "prod-test-session-token.json");
const OUT = path.join(DIR, "prod-test-session.json");
const args = new Set(process.argv.slice(2));
const scrub = (s) => String(s ?? "").replace(/[A-Za-z0-9_%.+/=-]{30,}/g, "<redacted>");

function tmpFile(name, data) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prodqa-"));
  const file = path.join(dir, name);
  writeFileSync(file, data, { mode: 0o600 });
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}
function wrangler(argv, label) {
  const r = spawnSync("npx", ["wrangler", ...argv], { encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`${label} failed: ${scrub(r.stderr || r.stdout).slice(-600)}`);
}

const health = await (await fetch(`${BASE}/api/health`)).json().catch(() => ({}));
const readsPct = Number(health?.reads?.pct ?? NaN);
if (!Number.isFinite(readsPct)) { console.error("could not read /api/health reads: refusing"); process.exit(3); }
if (readsPct >= 50) { console.error(`D1 reads at ${readsPct}% of the daily budget: refusing`); process.exit(3); }

if (args.has("--off")) {
  // Semgrep (QUAL1): the name of a Worker secret being deleted, not its value.
  wrangler(["secret", "delete", "TEST_SESSION_TOKEN", "--env", ""], "secret delete"); // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  rmSync(OUT, { force: true });
  console.log(JSON.stringify({ off: true }));
  process.exit(0);
}

if (args.has("--setup")) {
  const now = Date.now();
  const sql = tmpFile("setup.sql", [
    `INSERT OR IGNORE INTO users (id,email,name,email_verified,timezone,created_at,updated_at) VALUES ('${USER_ID}','${EMAIL}','Prod QA',1,'Australia/Sydney',${now},${now});`,
    `INSERT OR IGNORE INTO organizations (id,name,slug,timezone,country,is_demo,created_at) VALUES ('${ORG_ID}','Multies QA (test)','multies-qa-test-45','Australia/Sydney','AU',0,${now});`,
    `INSERT OR IGNORE INTO members (id,organization_id,user_id,role,created_at) VALUES ('${MEMBER_ID}','${ORG_ID}','${USER_ID}','owner',${now});`,
    `DELETE FROM sessions WHERE user_id = '${USER_ID}' AND login_method <> 'test-session';`,
  ].join("\n"));
  try { wrangler(["d1", "execute", DB, "--remote", "--file", sql.file, "--yes"], "d1 execute"); } finally { sql.done(); }
  const token = randomBytes(36).toString("base64url");
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify({ base: BASE, token }), { mode: 0o600 });
  const bulk = tmpFile("secrets.json", JSON.stringify({ TEST_SESSION_TOKEN: token, TEST_SESSION_USER_ID: USER_ID, TEST_SESSION_ORG_ID: ORG_ID }));
  // Semgrep (QUAL1): uploads a temporary file written at run time; no value here.
  try { wrangler(["secret", "bulk", bulk.file, "--env", ""], "secret bulk"); } finally { bulk.done(); } // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  console.log(JSON.stringify({ setup: true, user: USER_ID, org: ORG_ID }));
  process.exit(0);
}

if (!existsSync(TOKEN_FILE)) { console.error("no token file: run --setup first"); process.exit(2); }
const { token } = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
const r = await fetch(`${BASE}/api/_test-session`, { method: "POST", headers: { "x-test-session": token, "content-type": "application/json" }, body: "{}" });
if (r.status !== 200) { console.error(`mint answered ${r.status}: ${scrub(await r.text()).slice(0, 300)}`); process.exit(1); }
const minted = await r.json();
writeFileSync(OUT, JSON.stringify({ base: BASE, cookie_name: minted.cookie.name, cookie_value: minted.cookie.value, user_id: USER_ID, org_id: ORG_ID, expires_at: minted.expiresAt }), { mode: 0o600 });
const H = { cookie: `${minted.cookie.name}=${minted.cookie.value}`, "content-type": "application/json" };
const me = await fetch(`${BASE}/api/account/me`, { headers: H });
const mj = me.ok ? await me.json() : {};
const ws = await (await fetch(`${BASE}/api/account/workspaces`, { headers: H })).json().catch(() => ({}));
const scope = { me: me.status, org: mj?.organization?.id, isDemo: mj?.organization?.isDemo, role: mj?.organization?.role, workspaces: (ws?.workspaces ?? []).length };
if (scope.org !== ORG_ID || scope.isDemo !== false || scope.workspaces < 1) { console.error("scope check failed", JSON.stringify(scope)); process.exit(1); }

let seed = null;
if (args.has("--seed")) {
  const projects = await (await fetch(`${BASE}/api/projects`, { headers: H })).json();
  const list = projects.projects ?? projects.data ?? [];
  const existing = list.find((p) => p.name === "Windowing check");
  if (existing) seed = { project: existing.id, exists: true };
  else {
    const pr = await (await fetch(`${BASE}/api/projects`, { method: "POST", headers: H, body: JSON.stringify({ name: "Windowing check", key: "WIN" }) })).json();
    const pid = pr.project?.id;
    if (!pid) { console.error("project create failed", scrub(JSON.stringify(pr)).slice(0, 300)); process.exit(1); }
    const statuses = ["To do", "In progress", "Done"];
    const rows = ["title,status,priority"];
    for (let i = 1; i <= 90; i++) rows.push(`Check card ${String(i).padStart(2, "0")},${statuses[i <= 60 ? 0 : i <= 80 ? 1 : 2]},${["low", "medium", "high"][i % 3]}`);
    const imp = await fetch(`${BASE}/api/work-imports/run`, { method: "POST", headers: { ...H, "idempotency-key": `prodqa-seed-${Date.now()}` }, body: JSON.stringify({ fileName: "windowing-check.csv", content: rows.join("\n"), projectId: pid }) });
    const sp = await fetch(`${BASE}/api/sprints`, { method: "POST", headers: H, body: JSON.stringify({ projectId: pid, name: "QA sprint 1" }) });
    seed = { project: pid, import: imp.status, importBody: imp.status === 200 ? undefined : scrub(await imp.text()).slice(0, 200), sprint: sp.status };
  }
}
console.log(JSON.stringify({ minted: true, scope, expires: minted.expiresAt, seed }));
