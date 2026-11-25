/**
 * Randomness for anything a stranger should not guess: ids that end up in links, request ids,
 * decoy codes. Always the platform's cryptographic source (Workers, Node 20+ and browsers all have
 * `crypto.getRandomValues`); never Math.random. With no such source it throws rather than fall back.
 */

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** n random bytes from crypto.getRandomValues. Throws when the platform has no cryptographic source. */
export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") throw new Error("No secure random source on this platform.");
  return c.getRandomValues(new Uint8Array(n));
}

/**
 * A random string of `length` characters from `alphabet` (lowercase letters and digits by default).
 * Unbiased: bytes that would favour the first letters of the alphabet are dropped and drawn again.
 */
export function randomId(length = 16, alphabet = ID_ALPHABET, bytes: (n: number) => Uint8Array = randomBytes): string {
  if (alphabet.length < 2 || alphabet.length > 256) throw new Error("The alphabet needs 2 to 256 characters.");
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of bytes(Math.max(8, length - out.length) + 8)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** A random UUID (v4) from the platform. */
export function randomUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A number in [0, 1) from the cryptographic source: a drop-in default where code takes a `random()` for tests. */
export function randomFloat(): number {
  const b = randomBytes(4);
  return (((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!) / 2 ** 32;
}
