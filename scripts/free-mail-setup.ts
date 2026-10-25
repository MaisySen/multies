/**
 * One time setup for free addresses on a deployment (docs/runbooks/free-addresses.md).
 *
 * Makes the platform workspace ("org_platform") and an inbound key for it, as SQL for
 * `wrangler d1 execute`, so the Email Worker can deliver mail for the shared domain to this
 * deployment. The key secret is written to a file (mode 600), never printed.
 *
 *   APP_SECRET=... npx tsx scripts/free-mail-setup.ts --out /tmp/free-mail
 *   npx wrangler d1 execute mymail-au --remote --file /tmp/free-mail/setup.sql
 *   (cd email-worker && npx wrangler secret put MYMAIL_KEY_SECRET_PROD < /tmp/free-mail/secret)
 *
 * Then set MYMAIL_ROUTES on the Email Worker to route the shared domain here with that key id
 * (printed below, it is not a secret). Writes: 2 rows (about 4 with indexes).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { encryptSecret, newId, randomToken } from "../src/server/lib/crypto";

const out = process.argv[process.argv.indexOf("--out") + 1];
const appSecret = process.env.APP_SECRET;
if (!out || process.argv.indexOf("--out") < 0) throw new Error("Usage: --out <dir>");
if (!appSecret || appSecret.length < 32) throw new Error("Set APP_SECRET (the deployment's own) in the environment.");

const id = newId("ink");
const secret = `whsec_${randomToken(32)}`;
const now = Date.now();
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sql = [
  `INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('org_platform', 'Multies platform', 'mymail-platform', ${now});`,
  `INSERT INTO inbound_keys (id, org_id, secret_enc, created_at) VALUES (${q(id)}, 'org_platform', ${q(await encryptSecret(appSecret, secret))}, ${now});`,
].join("\n");
mkdirSync(out, { recursive: true, mode: 0o700 });
writeFileSync(`${out}/setup.sql`, sql + "\n", { mode: 0o600 });
writeFileSync(`${out}/secret`, secret, { mode: 0o600 });
console.log(JSON.stringify({ keyId: id, sql: `${out}/setup.sql`, secretFile: `${out}/secret` }));
