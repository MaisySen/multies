/**
 * R128 Team password vault, the browser side of the key model (files/catalogue/r128/DESIGN.md). Web Crypto only:
 * - passphrase -> PBKDF2 SHA-256 (600,000 rounds, per person salt) -> HKDF SHA-256 split into a wrap key (AES-GCM 256,
 *   never extractable) and an unlock proof (sent to the server only at unlock; it reveals nothing about the wrap key);
 * - an RSA-OAEP 3072 key pair per person; the private key is stored only AES-GCM encrypted under the wrap key and, after
 *   unlock, lives here as a non extractable key in memory;
 * - an AES-GCM 256 key per folder (and key version), wrapped with each member's public key;
 * - every item and folder name is one AES-GCM ciphertext with a fresh 12 byte IV, bound to its ids by additional data.
 * Nothing in this file logs, persists or sends a passphrase, key or plaintext.
 */
import { fromB64u, toB64u } from "@/web/lib/secret-crypto";
import { VAULT_KDF_ITERATIONS } from "@/shared/vault-r128";

const te = new TextEncoder();
const td = new TextDecoder();
type Bytes = Uint8Array<ArrayBuffer>;
const bytes = (b: Uint8Array): Bytes => b as Bytes;
const RSA: RsaHashedImportParams = { name: "RSA-OAEP", hash: "SHA-256" };

export interface PassKeys { wrapKey: CryptoKey; auth: string }

/** PBKDF2 then HKDF: one slow step, two independent outputs. */
export async function derivePassKeys(passphrase: string, saltB64: string, iterations: number): Promise<PassKeys> {
  const salt = bytes(fromB64u(saltB64));
  const base = await crypto.subtle.importKey("raw", te.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const master = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, 256);
  const hk = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey", "deriveBits"]);
  const wrapKey = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("multies vault wrap v1") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const auth = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("multies vault auth v1") }, hk, 256));
  return { wrapKey, auth: toB64u(auth) };
}

export const pkAad = (orgId: string, userId: string) => te.encode(`multies-vault:pk:v1:${orgId}:${userId}`);
export const itemAad = (folderId: string, itemId: string, version: number) => te.encode(`multies-vault:item:v1:${folderId}:${itemId}:${version}`);
export const folderAad = (folderId: string, version: number) => te.encode(`multies-vault:folder:v1:${folderId}:${version}`);

async function sealBytes(key: CryptoKey, data: Uint8Array, aad: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bytes(aad) }, key, bytes(data)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return toB64u(out);
}
async function openBytes(key: CryptoKey, b64: string, aad: Uint8Array): Promise<Uint8Array> {
  const all = fromB64u(b64);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(all.slice(0, 12)), additionalData: bytes(aad) }, key, bytes(all.slice(12))));
}

/** First 16 bytes of SHA-256 over the public key, as 32 hex characters. */
export async function fingerprintOf(spkiB64: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(fromB64u(spkiB64))));
  return Array.from(d.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** "ab12 cd34 ..." for people to compare out loud. */
export const showFingerprint = (hex: string) => (hex.match(/.{1,4}/g) ?? []).join(" ");

export interface NewAccount { publicKey: string; wrappedPrivateKey: string; salt: string; iterations: number; auth: string; fingerprint: string; privateKey: CryptoKey }

/** Makes the person's key pair and wraps the private key under the passphrase. Only the returned strings leave the browser. */
export async function createAccount(passphrase: string, orgId: string, userId: string, iterations = VAULT_KDF_ITERATIONS): Promise<NewAccount> {
  const salt = toB64u(crypto.getRandomValues(new Uint8Array(16)));
  const pass = await derivePassKeys(passphrase, salt, iterations);
  const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["wrapKey", "unwrapKey"]);
  const spki = toB64u(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const wrappedPrivateKey = await sealBytes(pass.wrapKey, pkcs8, pkAad(orgId, userId));
  pkcs8.fill(0);
  const privateKey = await openPrivateKey(pass.wrapKey, wrappedPrivateKey, orgId, userId);
  return { publicKey: spki, wrappedPrivateKey, salt, iterations, auth: pass.auth, fingerprint: await fingerprintOf(spki), privateKey };
}

/** Decrypts the stored private key into a NON extractable key. Throws on a wrong passphrase. */
export async function openPrivateKey(wrapKey: CryptoKey, wrappedB64: string, orgId: string, userId: string): Promise<CryptoKey> {
  const pkcs8 = await openBytes(wrapKey, wrappedB64, pkAad(orgId, userId));
  try { return await crypto.subtle.importKey("pkcs8", bytes(pkcs8), RSA, false, ["unwrapKey"]); } finally { pkcs8.fill(0); }
}

/** Passphrase change: decrypt with the old wrap key and encrypt again under the new one (the key pair stays). */
export async function rewrapPrivateKey(oldWrap: CryptoKey, newWrap: CryptoKey, wrappedB64: string, orgId: string, userId: string): Promise<string> {
  const pkcs8 = await openBytes(oldWrap, wrappedB64, pkAad(orgId, userId));
  try { return await sealBytes(newWrap, pkcs8, pkAad(orgId, userId)); } finally { pkcs8.fill(0); }
}

/** A new folder key. Extractable only so it can be wrapped for each member; it is never exported in clear. */
export const newFolderKey = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

export async function wrapFolderKey(folderKey: CryptoKey, publicKeyB64: string): Promise<string> {
  const pub = await crypto.subtle.importKey("spki", bytes(fromB64u(publicKeyB64)), RSA, false, ["wrapKey"]);
  return toB64u(new Uint8Array(await crypto.subtle.wrapKey("raw", folderKey, pub, { name: "RSA-OAEP" })));
}
export async function unwrapFolderKey(wrappedB64: string, privateKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey("raw", bytes(fromB64u(wrappedB64)), privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function sealJson(key: CryptoKey, value: unknown, aad: Uint8Array): Promise<string> {
  return sealBytes(key, te.encode(JSON.stringify(value)), aad);
}
export async function openJson<T>(key: CryptoKey, b64: string, aad: Uint8Array): Promise<T> {
  return JSON.parse(td.decode(await openBytes(key, b64, aad))) as T;
}

/** The item as people see it. All of it is encrypted together. */
export interface VaultItemPlain { title: string; username: string; password: string; url: string; notes: string; fields?: { label: string; value: string; secret: boolean }[] }
export interface VaultFolderPlain { name: string }

/** Ids are random and made here, because they are bound into the encryption. */
export function randomId(prefix: "vf" | "vi"): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  while (s.length < 20) {
    const r = crypto.getRandomValues(new Uint8Array(32));
    for (const b of r) if (b < 252 && s.length < 20) s += abc[b % 36];
  }
  return `${prefix}_${s}`;
}

// ---------------------------------------------------------------- password generator

export interface GenOptions { length: number; upper: boolean; lower: boolean; digits: boolean; symbols: boolean; avoidSimilar: boolean }
export const GEN_DEFAULT: GenOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true, avoidSimilar: true };
const SIMILAR = /[Il1O0o|`'"]/g;
export function genSets(o: GenOptions): string[] {
  const sets = [
    o.upper ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "", o.lower ? "abcdefghijklmnopqrstuvwxyz" : "", o.digits ? "0123456789" : "", o.symbols ? "!#$%&()*+,./:;<=>?@[]^_{}~-" : "",
  ].map((s) => (o.avoidSimilar ? s.replace(SIMILAR, "") : s)).filter(Boolean);
  return sets.length ? sets : ["abcdefghijkmnpqrstuvwxyz"];
}
/** An unbiased random index below n (rejection sampling over 32 bit values). */
export function randomBelow(n: number, rand: (a: Uint32Array) => Uint32Array = (a) => crypto.getRandomValues(a)): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) { const v = rand(buf)[0]!; if (v < limit) return v % n; }
}
/** A password with at least one character of every chosen kind, then shuffled (Fisher Yates). */
export function generatePassword(o: GenOptions): string {
  const len = Math.min(128, Math.max(8, Math.floor(o.length) || 20));
  const sets = genSets(o);
  const all = sets.join("");
  const out = sets.map((s) => s[randomBelow(s.length)]!);
  while (out.length < len) out.push(all[randomBelow(all.length)]!);
  for (let i = out.length - 1; i > 0; i--) { const j = randomBelow(i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out.join("");
}
export function entropyBits(o: GenOptions): number {
  return Math.floor(Math.min(128, Math.max(8, o.length)) * Math.log2(genSets(o).join("").length));
}
export function strengthWord(bits: number): "Weak" | "Fair" | "Strong" | "Very strong" {
  return bits < 50 ? "Weak" : bits < 70 ? "Fair" : bits < 100 ? "Strong" : "Very strong";
}
/** A rough passphrase check for set up (length and variety); the KDF does the real work. */
export function passphraseProblem(p: string): string | null {
  if (p.length < 10) return "Use at least 10 characters.";
  if (/^(.)\1+$/.test(p)) return "Use more than one repeated character.";
  if (new Set(p.toLowerCase()).size < 5) return "Use a less repetitive passphrase.";
  return null;
}
