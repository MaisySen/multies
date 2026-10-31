/**
 * R88: secret links, the browser side. A fresh 256 bit key encrypts the secret with AES GCM (12 byte nonce first);
 * with a passphrase the AES key is PBKDF2(passphrase, salt = the link key). Only the ciphertext goes to Multies;
 * the key goes into the link after "#", which browsers never send to a server. The public page (/x/_/secret.js)
 * does the same steps backwards. Plaintext layout: 4 byte big endian length, a small JSON header { k, n, t }, then
 * the body (UTF 8 text or the file's bytes).
 */
import { SECRET_KDF_ROUNDS } from "@/shared/secure-share";

export interface SecretPlain { kind: "text" | "file"; text?: string; bytes?: Uint8Array; name?: string; type?: string }

export function toB64u(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function aesKey(raw: Uint8Array, passphrase: string | null, use: KeyUsage[]): Promise<CryptoKey> {
  const keyBytes = raw as Uint8Array<ArrayBuffer>;
  if (!passphrase) return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, use);
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: keyBytes, iterations: SECRET_KDF_ROUNDS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, use);
}

function pack(p: SecretPlain): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify(p.kind === "file" ? { k: "file", n: p.name ?? "file", t: p.type ?? "" } : { k: "text" }));
  const body = p.kind === "file" ? (p.bytes ?? new Uint8Array()) : new TextEncoder().encode(p.text ?? "");
  const out = new Uint8Array(4 + meta.length + body.length);
  new DataView(out.buffer).setUint32(0, meta.length);
  out.set(meta, 4);
  out.set(body, 4 + meta.length);
  return out;
}

/** Encrypts a secret. Returns the ciphertext for the server and the key for the link's fragment (both base64url). */
export async function encryptSecret(p: SecretPlain, passphrase: string | null = null): Promise<{ ciphertext: string; key: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await aesKey(raw, passphrase, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, pack(p) as Uint8Array<ArrayBuffer>));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv); all.set(ct, 12);
  return { ciphertext: toB64u(all), key: toB64u(raw) };
}

/** The reverse (the public page has its own copy; this one is for tests and a future in app preview). */
export async function decryptSecret(ciphertext: string, key: string, passphrase: string | null = null): Promise<SecretPlain> {
  const data = fromB64u(ciphertext);
  const k = await aesKey(fromB64u(key), passphrase, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, k, data.slice(12)));
  const len = new DataView(pt.buffer).getUint32(0);
  const meta = JSON.parse(new TextDecoder().decode(pt.slice(4, 4 + len))) as { k: string; n?: string; t?: string };
  const body = pt.slice(4 + len);
  return meta.k === "file" ? { kind: "file", bytes: body, name: meta.n, type: meta.t } : { kind: "text", text: new TextDecoder().decode(body) };
}

/** The link the recipient opens: the server's URL plus "#" and the key. */
export const secretLink = (url: string, key: string) => `${url}#${key}`;
