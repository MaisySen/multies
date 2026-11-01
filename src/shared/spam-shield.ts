/**
 * R92: the spam shield, shared by public forms (booking pages, time polls, event RSVPs; R93 Forms reuses it).
 * Invisible to people: the page asks the server for a signed challenge, the browser solves a small proof of work
 * (find a number whose SHA 256 with the salt starts with N zero bits), a hidden honeypot field must stay empty,
 * and the form must not be sent faster than a person can fill it. No captcha and nothing paid.
 * This file runs in the browser and on the server (WebCrypto only).
 */
export interface ShieldChallenge {
  /** Unique id, also the one time use key. */
  id: string;
  /** Which form it is for (book, poll, event, form...). */
  form: string;
  salt: string;
  /** Leading zero bits the answer's hash needs. */
  difficulty: number;
  issuedAt: number;
  expiresAt: number;
  /** Server signature over the fields above. */
  sig: string;
}

/** What a public form sends back with its body. */
export interface ShieldAnswer {
  challenge: ShieldChallenge;
  nonce: number;
  /** The honeypot field's value; people never see it, so it stays empty. */
  hp?: string;
}

export const SHIELD_HONEYPOT_NAME = "website";
export const SHIELD_DEFAULT_DIFFICULTY = 14;
export const SHIELD_MAX_DIFFICULTY = 22;
export const SHIELD_TTL_MS = 30 * 60_000;
/** Faster than this from page load to send is a script, not a person. */
export const SHIELD_MIN_FILL_MS = 1500;

export function shieldPayload(c: Omit<ShieldChallenge, "sig">): string {
  return [c.id, c.form, c.salt, c.difficulty, c.issuedAt, c.expiresAt].join(".");
}

export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export async function shieldHash(salt: string, nonce: number): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`${salt}:${nonce}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function checkWork(salt: string, nonce: number, difficulty: number): Promise<boolean> {
  if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
  return leadingZeroBits(await shieldHash(salt, nonce)) >= difficulty;
}

/** Finds the answer. Yields to the page every few thousand tries so typing stays smooth. */
export async function solveWork(salt: string, difficulty: number, opts: { maxTries?: number; signal?: AbortSignal } = {}): Promise<number> {
  const max = opts.maxTries ?? 2 ** (Math.min(difficulty, SHIELD_MAX_DIFFICULTY) + 6);
  for (let nonce = 0; nonce < max; nonce++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    if (await checkWork(salt, nonce, difficulty)) return nonce;
    if (nonce % 4000 === 3999) await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("no answer found");
}

/** Reasons a check fails, for logs and tests (people see one plain message). */
export type ShieldFailure = "missing" | "bad_signature" | "wrong_form" | "expired" | "too_fast" | "honeypot" | "bad_work" | "reused";
export const SHIELD_MESSAGE = "We could not confirm this was sent by a person. Wait a moment and send it again, or reload the page.";
