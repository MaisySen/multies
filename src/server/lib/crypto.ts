/**
 * Crypto primitives built only on WebCrypto, so they behave identically on Node 20+
 * and on Cloudflare Workers.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function toB64Url(buf: Uint8Array): string {
  return toB64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return toB64Url(randomBytes(bytes));
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Prefixed, sortable-enough random id, e.g. `dom_k3j2...`. */
export function newId(prefix: string): string {
  const bytes = randomBytes(16);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % 36];
  return `${prefix}_${s}`;
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await subtle.digest("SHA-256", enc.encode(input)));
}

export async function sha256HexBytes(input: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
  return toHex(await subtle.digest("SHA-256", input));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Passwords: PBKDF2-SHA256. 100k iterations is the ceiling Cloudflare Workers
// allows for PBKDF2; the format records the parameters so they can be raised.
// ---------------------------------------------------------------------------
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, iter, saltB64, hashB64] = stored.split("$");
  if (algo !== "pbkdf2_sha256" || !iter || !saltB64 || !hashB64) return false;
  const hash = await pbkdf2(password, fromB64(saltB64), Number(iter));
  return safeEqual(toB64(hash), hashB64);
}

// ---------------------------------------------------------------------------
// Symmetric encryption for secrets at rest (DKIM private keys, webhook secrets).
// AES-256-GCM with a key derived from the app secret via HKDF.
// ---------------------------------------------------------------------------
const aesKeys = new Map<string, Promise<CryptoKey>>();
function aesKey(appSecret: string): Promise<CryptoKey> {
  let k = aesKeys.get(appSecret);
  if (!k) {
    k = (async () => {
      const ikm = await subtle.importKey("raw", enc.encode(appSecret), "HKDF", false, ["deriveKey"]);
      return subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("mymail/at-rest/v1"), info: enc.encode("aes-gcm") },
        ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
      );
    })();
    aesKeys.set(appSecret, k);
  }
  return k;
}

export async function encryptSecret(appSecret: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(appSecret), enc.encode(plaintext));
  return `v1:${toB64(iv)}:${toB64(ct)}`;
}

export async function decryptSecret(appSecret: string, payload: string): Promise<string> {
  const [v, ivB64, ctB64] = payload.split(":");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("Unsupported ciphertext");
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, await aesKey(appSecret), fromB64(ctB64));
  return dec.decode(pt);
}

// ---------------------------------------------------------------------------
// DKIM keys: RSA-2048. The public key is published as the `p=` value of the
// DKIM TXT record (base64 SubjectPublicKeyInfo); the private key is PKCS#8 PEM.
// ---------------------------------------------------------------------------
export async function generateDkimKeyPair(): Promise<{ publicKeyB64: string; privateKeyPem: string }> {
  const pair = (await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${toB64(pkcs8).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { publicKeyB64: toB64(spki), privateKeyPem: pem };
}
