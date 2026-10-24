/**
 * Creates (or re-creates) the fixed App Review demo login on a deployed MyMail.
 *
 *   REVIEW_PASSWORD=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *     npx tsx scripts/review-account.ts --base https://mymail.mymail-app.workers.dev --db mymail-au [--env staging] [--email appreview@example.com]
 *
 * It opens a demo workspace (sample mail, agents, tasks, docs, contacts), seeds it, then
 * gives its user a fixed email and password through wrangler d1 execute, and renames the
 * workspace. Add the printed workspace id to KEEP_DEMO_ORG_IDS (wrangler.toml) so the
 * daily demo purge keeps it. Demo workspaces never send real mail, so App Review can try
 * every screen safely. Run it again if a reviewer deletes the account.
 */
import { execFileSync } from "node:child_process";
import { hashPassword, newId } from "../src/server/lib/crypto";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg("base") ?? "";
const db = arg("db") ?? "";
const env = arg("env");
const email = (arg("email", "appreview@example.com") ?? "").toLowerCase();
const password = process.env.REVIEW_PASSWORD ?? "";
if (!base || !db || password.length < 12) {
  console.error("usage: REVIEW_PASSWORD=<12+ chars> tsx scripts/review-account.ts --base <url> --db <d1 name> [--env staging] [--email x]");
  process.exit(2);
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

function d1(sql: string) {
  const args = ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", sql, ...(env ? ["--env", env] : [])];
  const out = execFileSync("npx", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(out.slice(out.indexOf("[")))[0].results as Record<string, unknown>[];
}

async function main() {
  const existing = d1(`SELECT id FROM users WHERE email = ${q(email)}`);
  if (existing.length) {
    console.log(`${email} already exists (${String(existing[0].id)}); delete it first to re-create.`);
    return;
  }
  const res = await fetch(`${base}/api/account/demo`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (res.status !== 201) throw new Error(`demo answered ${res.status}`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  for (let i = 0; i < 3; i++) {
    const seed = await fetch(`${base}/api/account/demo/seed`, { method: "POST", headers: { cookie } });
    if (!seed.ok || (await seed.json() as { ran?: number }).ran === 0) break;
  }
  const me = await (await fetch(`${base}/api/account/me`, { headers: { cookie } })).json() as { user: { id: string }; organization: { id: string } };
  const now = Date.now();
  const hash = await hashPassword(password);
  d1([
    `UPDATE users SET email = ${q(email)}, name = 'App Review', email_verified = 1 WHERE id = ${q(me.user.id)}`,
    // A demo user already has a credential row with a random password: replace that one.
    d1(`SELECT id FROM accounts WHERE user_id = ${q(me.user.id)} AND provider_id = 'credential'`).length
      ? `UPDATE accounts SET password = ${q(hash)}, updated_at = ${now} WHERE user_id = ${q(me.user.id)} AND provider_id = 'credential'`
      : `INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (${q(newId("acc"))}, ${q(me.user.id)}, 'credential', ${q(me.user.id)}, ${q(hash)}, ${now}, ${now})`,
    `UPDATE organizations SET name = 'Harbour Coffee Co (App Review)' WHERE id = ${q(me.organization.id)}`,
  ].join("; "));
  const check = await fetch(`${base}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email, password }) });
  console.log(JSON.stringify({ email, userId: me.user.id, workspaceId: me.organization.id, signIn: check.status }));
  console.log(`Add ${me.organization.id} to KEEP_DEMO_ORG_IDS in wrangler.toml and deploy.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
