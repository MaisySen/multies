#!/usr/bin/env node
/**
 * R76 (security review M2): writes a signed x-multies-check header line to a mode 600 file, for our own smoke and QA
 * checks, so a check opens a demo marked check- that never uses up the visitors' daily demos.
 *
 *   node scripts/creds.mjs run QA_CHECK_TOKEN,QA_CHECK_TOKEN_STAGING -- node scripts/check-header.mjs <base-url> <out-file>
 *
 * The value is v1.<unix seconds>.<hex HMAC-SHA256 of "v1.<seconds>">, good for five minutes either way, so make a fresh
 * one before each demo request. Staging and production hold different tokens: a base URL on the staging host signs
 * with QA_CHECK_TOKEN_STAGING. The token itself is never printed and never sent.
 * With --value the file holds only the value (for a Playwright extraHTTPHeaders read).
 */
import { createHmac } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";

const args = process.argv.slice(2).filter((a) => a !== "--value");
const valueOnly = process.argv.includes("--value");
const [base, out] = args;
if (!base || !out) { console.error("usage: check-header.mjs <base-url> <out-file> [--value]"); process.exit(2); }
const staging = /staging|preview\./i.test(base);
const token = (staging ? process.env.QA_CHECK_TOKEN_STAGING : process.env.QA_CHECK_TOKEN) ?? "";
if (token.trim().length < 24) { console.error(`check-header: no ${staging ? "QA_CHECK_TOKEN_STAGING" : "QA_CHECK_TOKEN"} in the environment`); process.exit(3); }
const ts = Math.floor(Date.now() / 1000);
const value = `v1.${ts}.${createHmac("sha256", token.trim()).update(`v1.${ts}`).digest("hex")}`;
writeFileSync(out, valueOnly ? value : `x-multies-check: ${value}`, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`check-header: wrote ${out} (${staging ? "staging" : "production"} token)`);
