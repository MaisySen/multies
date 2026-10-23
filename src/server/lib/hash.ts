/**
 * A short, fast, non-cryptographic hash (FNV-1a, 64-bit) for bucketing keys such as a
 * rate limit client id. Never use it for secrets; use SHA-256 for those.
 */
export function createHash(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(36);
}
