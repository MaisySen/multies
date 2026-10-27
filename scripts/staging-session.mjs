#!/usr/bin/env node
/**
 * R42: a seeded session for the STAGING test user, so the deploy gate can make signed in GETs on staging
 * (staging caps new demos at 2 a day). App side only: it writes one row to the staging D1 sessions table and signs
 * the cookie with the staging app secret, the same way the app does. Nothing changes in the app or at the identity
 * provider, so production is untouched. It refuses anything but the staging database.
 *
 *   node scripts/creds.mjs run APP_SECRET_STAGING,CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID -- node scripts/staging-session.mjs
 *
 * The cookie is written to ~/.multies-secrets/staging-test-session.json (mode 600) and never printed; the SQL goes
 * through a mode 600 temp file (no secret in argv). Older seeded sessions of the same user are removed first.
 * The session lasts 30 days and rolls forward once a day while it is used. scripts/staging-signed-gets.py reads it.
 */
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DB = "mymail-staging";
const BASE = "https://mymail-staging.mymail-app.workers.dev";
/** The staging test user and its workspace ("Staging's workspace", not a demo, so it can send email). */
const USER_ID = process.env.STAGING_TEST_USER_ID ?? "usr_g946j7sotvkn4vvo";
const ORG_ID = process.env.STAGING_TEST_ORG_ID ?? "org_ve8gs0e7peydwvfi";
const OUT = path.join(os.homedir(), ".multies-secrets", "staging-test-session.json");

const secret = process.env.APP_SECRET_STAGING;
if (!secret || secret.length < 32) { console.error("APP_SECRET_STAGING missing: run through scripts/creds.mjs run"); process.exit(2); }
if (!/^usr_[a-z0-9]+$/.test(USER_ID) || !/^org_[a-z0-9]+$/.test(ORG_ID)) { console.error("bad ids"); process.exit(2); }

const token = randomBytes(24).toString("base64url");
const id = `ses_${randomBytes(8).toString("hex")}`;
const now = Date.now();
const expires = now + 30 * 24 * 3600_000;
const sql = [
  `DELETE FROM sessions WHERE user_id = '${USER_ID}' AND login_method = 'staging-seed';`,
  `INSERT INTO sessions (id, token, user_id, expires_at, ip_address, user_agent, active_organization_id, login_method, created_at, updated_at) VALUES ('${id}', '${token}', '${USER_ID}', ${expires}, NULL, 'staging-signed-gets', '${ORG_ID}', 'staging-seed', ${now}, ${now});`,
].join("\n");
const dir = mkdtempSync(path.join(os.tmpdir(), "stg-seed-"));
const file = path.join(dir, "seed.sql");
writeFileSync(file, sql, { mode: 0o600 });
try {
  const r = spawnSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--env", "staging", "--file", file, "--yes"], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) { console.error("wrangler d1 execute failed:", (r.stderr || r.stdout || "").replaceAll(token, "<token>").slice(-600)); process.exit(1); }
} finally { rmSync(dir, { recursive: true, force: true }); }

const signature = createHmac("sha256", secret).update(token).digest("base64");
const cookie = encodeURIComponent(`${token}.${signature}`);
mkdirSync(path.dirname(OUT), { recursive: true, mode: 0o700 });
writeFileSync(OUT, JSON.stringify({ base: BASE, cookie_name: "__Host-mymail.session_token", cookie_value: cookie, user_id: USER_ID, expires_at: new Date(expires).toISOString() }), { mode: 0o600 });
const me = await fetch(`${BASE}/api/account/me`, { headers: { cookie: `__Host-mymail.session_token=${cookie}` } });
console.log(JSON.stringify({ seeded: true, session: id, me: me.status, expires: new Date(expires).toISOString() }));
process.exit(me.status === 200 ? 0 : 1);
