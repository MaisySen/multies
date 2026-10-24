#!/usr/bin/env node
/**
 * Fills .env for a self-hosted MyMail with strong random secrets.
 *
 *   node scripts/selfhost/gen-env.mjs            (creates .env from .env.example, or tops up an existing .env)
 *   docker run --rm -v "$PWD:/w" -w /w node:22-alpine node scripts/selfhost/gen-env.mjs   (no Node on the computer)
 *
 * Only empty values are filled; anything already set in .env is left as it is, so it is safe
 * to run again. Secrets are never printed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const secret = (bytes = 36) => randomBytes(bytes).toString("base64url");
const GENERATED = {
  APP_SECRET: () => secret(48),
  STALWART_ADMIN_SECRET: () => secret(),
  STALWART_SETUP_ADMIN: () => `admin:${secret()}`,
  MTA_HOOK_TOKEN: () => secret(),
  SMTP_PASS: () => secret(),
};

const examplePath = ".env.example";
const envPath = process.argv[2] ?? ".env";
if (!existsSync(examplePath)) {
  console.error("Run this from the MyMail folder (where .env.example is).");
  process.exit(1);
}
// A new .env starts from .env.example with the values that suit a self-hosted install.
const SELFHOST = { APP_MODE: "production", APP_URL: "http://localhost:8787", DATABASE_PATH: "/data/mymail.db" };
const fresh = !existsSync(envPath);
let source = readFileSync(fresh ? examplePath : envPath, "utf8");
if (fresh) for (const [k, v] of Object.entries(SELFHOST)) source = source.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
const filled = [];
const lines = source.split(/\r?\n/).map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m || !(m[1] in GENERATED) || m[2].trim() !== "") return line;
  filled.push(m[1]);
  return `${m[1]}=${GENERATED[m[1]]()}`;
});
// Any generated key missing from the file entirely is appended.
for (const key of Object.keys(GENERATED)) {
  if (!lines.some((l) => l.startsWith(`${key}=`))) { lines.push(`${key}=${GENERATED[key]()}`); filled.push(key); }
}
writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
console.log(filled.length ? `${envPath}: generated ${filled.join(", ")}` : `${envPath}: every secret was already set, nothing changed`);
