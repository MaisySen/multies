/**
 * R32: Web push from the Worker with WebCrypto only (no push library).
 *  - RFC 8291: the payload is encrypted for one browser (aes128gcm content coding, one record).
 *  - RFC 8292: the request carries a VAPID JWT (ES256) signed with our key, plus our public key.
 * The browser's push service only ever sees ciphertext. Payloads carry a type, an id, a title and the
 * path to open, never message text.
 */

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}

/** HKDF with one block of output (we never need more than 32 bytes). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** An uncompressed P-256 public key (65 bytes, 0x04 || x || y) as a JWK. */
export function publicJwk(raw: Uint8Array, d?: string): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("not an uncompressed P-256 public key");
  return { kty: "EC", crv: "P-256", x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)), ...(d ? { d } : {}), ext: true };
}

export interface EncryptOptions {
  /** Fixed values for the RFC 8291 test vectors; random in real use. */
  salt?: Uint8Array;
  serverKeys?: { publicRaw: Uint8Array; privateD: string };
  /** Record size; the RFC example uses 4096. */
  recordSize?: number;
}

/**
 * Encrypts one push message for a subscription (RFC 8291 section 3 and 4).
 * Returns the full body: header (salt, rs, idlen, keyid) followed by the single record.
 */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (authSecret.length !== 16) throw new Error("auth secret must be 16 bytes");
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const rs = opts.recordSize ?? 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error("payload too large for one record");

  let asPublic: Uint8Array;
  let asPrivate: CryptoKey;
  if (opts.serverKeys) {
    asPublic = opts.serverKeys.publicRaw;
    asPrivate = await crypto.subtle.importKey("jwk", publicJwk(asPublic, opts.serverKeys.privateD), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));

  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["encrypt"]);
  // One record, the last: the plaintext then the 0x02 delimiter, no padding.
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, key, buf(concat(plaintext, new Uint8Array([2])))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, record);
}

/** The inverse, used by the tests (and handy for checking a vector). */
export async function decryptPayload(body: Uint8Array, uaPrivateD: string, uaPublicB64: string, auth: string): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const uaPublic = b64urlDecode(uaPublicB64);
  const uaPrivate = await crypto.subtle.importKey("jwk", publicJwk(uaPublic, uaPrivateD), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const asKey = await crypto.subtle.importKey("raw", buf(asPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
  const ikm = await hkdf(b64urlDecode(auth), ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", buf(cek), { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce) }, key, buf(body.slice(21 + idlen))));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error("not a last record");
  return plain.slice(0, end);
}

export interface VapidKeys {
  /** Uncompressed public key, base64url (what browsers take as applicationServerKey). */
  publicKey: string;
  /** The private scalar d, base64url, or a whole private JWK as JSON. */
  privateKey: string;
  /** mailto: or https: contact for the push services. */
  subject: string;
}

/** Reads VAPID_PRIVATE_KEY in either form: a base64url d or a JSON JWK. */
export function privateD(privateKey: string): string {
  const t = privateKey.trim();
  if (t.startsWith("{")) {
    const jwk = JSON.parse(t) as { d?: string };
    if (!jwk.d) throw new Error("the VAPID private JWK has no d");
    return jwk.d;
  }
  return t;
}

/** RFC 8292: a signed JWT for the push service's origin, valid for 12 hours. */
export async function vapidJwt(endpoint: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })));
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("jwk", publicJwk(b64urlDecode(keys.publicKey), privateD(keys.privateKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto gives the raw r || s form JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, buf(enc.encode(signingInput)));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

export interface WebPushRequest { url: string; init: RequestInit }

/** Builds the HTTP request to one subscription's endpoint. */
export async function buildWebPushRequest(sub: { endpoint: string; p256dh: string; auth: string }, payload: unknown, keys: VapidKeys, opts: { ttl?: number; topic?: string; urgency?: "normal" | "high" } = {}): Promise<WebPushRequest> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const jwt = await vapidJwt(sub.endpoint, keys);
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    ttl: String(opts.ttl ?? 86_400),
    urgency: opts.urgency ?? "normal",
    authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
  };
  // A topic replaces an undelivered message with the same topic (32 url-safe characters at most).
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  return { url: sub.endpoint, init: { method: "POST", headers, body: buf(body) } };
}

/** Push service endpoints we send to: https only, never a private or local host. */
export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}
