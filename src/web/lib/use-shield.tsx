/**
 * R92: the spam shield on public forms. Fetches a signed challenge and solves its small proof of work in the
 * background while the person types, so sending is instant. Pair it with <Honeypot /> inside the form.
 * A real person is never turned away silently: a failed or late challenge is fetched again, the minimum fill time
 * is waited out before sending, and a refused check is retried once with a fresh challenge (send()).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/web/lib/api";
import { SHIELD_HONEYPOT_NAME, SHIELD_MIN_FILL_MS, SHIELD_TTL_MS, solveWork, type ShieldAnswer, type ShieldChallenge } from "@/shared/spam-shield";

type Job = { at: number; done: Promise<{ challenge: ShieldChallenge; nonce: number } | null> };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** R93: `path` picks the shield endpoint (forms use /pub/forms/shield); `enabled` false makes it a no op. */
export function useShield(form: string, path = "/pub/booking/shield", enabled = true) {
  const [hp, setHp] = useState("");
  const job = useRef<Job | null>(null);
  const start = useCallback(() => {
    if (!enabled) return;
    const at = Date.now();
    job.current = {
      at,
      done: (async () => {
        try {
          const { challenge } = await api.get<{ challenge: ShieldChallenge }>(`${path}?form=${form}`);
          return { challenge, nonce: await solveWork(challenge.salt, challenge.difficulty) };
        } catch {
          return null;
        }
      })(),
    };
  }, [form, path, enabled]);
  useEffect(() => { start(); }, [start]);
  /** The answer to send with the form. Each challenge works once, so a fresh one starts for the next send. */
  const answer = useCallback(async (fresh = false): Promise<ShieldAnswer | undefined> => {
    if (!enabled) return undefined;
    // A challenge that failed to load, is close to expiry, or was refused is replaced before sending.
    if (fresh || !job.current || Date.now() - job.current.at > SHIELD_TTL_MS - 120_000) start();
    let current = job.current!;
    let got = await current.done;
    if (!got) { start(); current = job.current!; got = await current.done; }
    const age = Date.now() - current.at;
    if (age < SHIELD_MIN_FILL_MS + 250) await wait(SHIELD_MIN_FILL_MS + 250 - age);
    start();
    return got ? { ...got, hp } : undefined;
  }, [hp, start, enabled]);
  /** Sends with the shield; a refused check (other than the hidden field) is retried once with a fresh challenge. */
  const send = useCallback(async <T,>(post: (shield: ShieldAnswer | undefined) => Promise<T>): Promise<T> => {
    try {
      return await post(await answer());
    } catch (err) {
      const reason = err instanceof ApiError && err.code === "spam_check_failed" ? (err.details as { reason?: string } | undefined)?.reason : undefined;
      if (!reason || reason === "honeypot") throw err;
      return await post(await answer(true));
    }
  }, [answer]);
  return { answer, send, honeypot: { value: hp, onChange: setHp } };
}

/** A field people never see or reach; scripts that fill every field give themselves away. */
export function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
      <label>Leave this empty<input type="text" name={SHIELD_HONEYPOT_NAME} tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} /></label>
    </div>
  );
}
