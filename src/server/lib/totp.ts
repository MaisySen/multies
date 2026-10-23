/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30 s) and RFC 4648 base32, on WebCrypto only.
 * Compatible with Google Authenticator, 1Password, Authy and friends.
 */
import { randomBytes } from "./crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_STEP_S = 30;
export const stepAt = (now: Date) => Math.floor(now.getTime() / 1000 / TOTP_STEP_S);

export async function totpCode(secretB32: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  let n = step;
  for (let i = 7; i >= 0; i--) { msg[i] = n & 0xff; n = Math.floor(n / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 0xf;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * Checks a code against the current step and one step either side (clock drift).
 * Returns the matching step, or null. Steps at or before `lastStep` are refused (replay).
 */
export async function verifyTotp(secretB32: string, code: string, now: Date, lastStep?: number | null): Promise<number | null> {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const cur = stepAt(now);
  for (const s of [cur, cur - 1, cur + 1]) {
    if (lastStep != null && s <= lastStep) continue;
    if ((await totpCode(secretB32, s)) === clean) return s;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
