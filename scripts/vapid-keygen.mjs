#!/usr/bin/env node
/**
 * R32: makes a VAPID key pair for browser notifications and writes it to a mode 600 file.
 *   node scripts/vapid-keygen.mjs /path/to/vapid.json
 * The file holds { publicKey, privateKey, subject }: publicKey is the uncompressed P-256 point (base64url),
 * privateKey is the private scalar d (base64url). Only the public key is printed. Set them with:
 *   VAPID_PUBLIC_KEY + VAPID_SUBJECT as Worker vars, VAPID_PRIVATE_KEY as a Worker secret (value on stdin).
 */
import { writeFileSync, existsSync, chmodSync } from "node:fs";
import { webcrypto as crypto } from "node:crypto";

const file = process.argv[2];
if (!file) { console.error("usage: node scripts/vapid-keygen.mjs <output.json>"); process.exit(2); }
if (existsSync(file)) { console.error(`${file} already exists; not overwriting a key.`); process.exit(1); }
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = b64url(await crypto.subtle.exportKey("raw", pair.publicKey));
const subject = process.env.VAPID_SUBJECT || "mailto:security@multies.si";
writeFileSync(file, JSON.stringify({ publicKey, privateKey: jwk.d, subject }, null, 2) + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`VAPID key pair written to ${file} (mode 600). Public key: ${publicKey}`);
