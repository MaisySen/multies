/**
 * R92: server side of the spam shield (src/shared/spam-shield.ts). Issues signed challenges and checks answers:
 * signature, form, expiry, minimum fill time, honeypot, proof of work, and one time use (shield_spent).
 * Per IP rate limits sit on the routes that use it.
 */
import { lt } from "drizzle-orm";
import type { Deps } from "../context";
import { shieldSpent } from "../db/schema";
import { hmacSha256Hex, randomToken } from "../lib/crypto";
import { HttpError } from "../lib/errors";
import {
  SHIELD_DEFAULT_DIFFICULTY, SHIELD_MESSAGE, SHIELD_MIN_FILL_MS, SHIELD_TTL_MS, checkWork, shieldPayload,
  type ShieldAnswer, type ShieldChallenge, type ShieldFailure,
} from "@/shared/spam-shield";

const FORM = /^[a-z][a-z0-9_]{1,31}$/;

function secretOf(deps: Deps) {
  return `shield:${deps.config.appSecret || "dev-secret"}`;
}

/** Tests and local runs can lower the work with SHIELD_DIFFICULTY in the config's env. */
export function shieldDifficulty(deps: Deps): number {
  const d = deps.config.shieldDifficulty;
  return typeof d === "number" && d >= 0 && d <= 22 ? d : SHIELD_DEFAULT_DIFFICULTY;
}

export async function issueChallenge(deps: Deps, form: string): Promise<ShieldChallenge> {
  if (!FORM.test(form)) throw new HttpError(422, "validation_failed", "Unknown form.");
  const now = deps.now().getTime();
  const base = { id: randomToken(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 16), form, salt: randomToken(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 16), difficulty: shieldDifficulty(deps), issuedAt: now, expiresAt: now + SHIELD_TTL_MS };
  return { ...base, sig: await hmacSha256Hex(secretOf(deps), shieldPayload(base)) };
}

/** Checks without spending. Returns the reason it fails, or null when it passes. */
export async function shieldFailure(deps: Deps, form: string, a: ShieldAnswer | undefined | null): Promise<ShieldFailure | null> {
  if (!a || !a.challenge || typeof a.nonce !== "number") return "missing";
  if (a.hp && a.hp.trim()) return "honeypot";
  const c = a.challenge;
  const { sig, ...rest } = c;
  const want = await hmacSha256Hex(secretOf(deps), shieldPayload(rest));
  if (typeof sig !== "string" || sig.length !== want.length || sig !== want) return "bad_signature";
  if (c.form !== form) return "wrong_form";
  const now = deps.now().getTime();
  if (now > c.expiresAt) return "expired";
  if (now - c.issuedAt < SHIELD_MIN_FILL_MS) return "too_fast";
  if (!(await checkWork(c.salt, a.nonce, c.difficulty))) return "bad_work";
  return null;
}

/** Throws a plain 422 unless the answer passes, then marks the challenge used so it works once. */
export async function requireShield(deps: Deps, form: string, a: ShieldAnswer | undefined | null): Promise<void> {
  const fail = await shieldFailure(deps, form, a);
  if (fail) throw new HttpError(422, "spam_check_failed", SHIELD_MESSAGE, { reason: fail });
  const now = deps.now().getTime();
  const spent = await deps.db.insert(shieldSpent).values({ id: `${form}:${a!.challenge.id}`, expiresAt: a!.challenge.expiresAt }).onConflictDoNothing().returning({ id: shieldSpent.id });
  if (!spent.length) throw new HttpError(422, "spam_check_failed", SHIELD_MESSAGE, { reason: "reused" });
  if (Math.random() < 0.02) await deps.db.delete(shieldSpent).where(lt(shieldSpent.expiresAt, now)).catch(() => undefined);
}
