/**
 * R92: the spam shield on public forms. Fetches a signed challenge and solves its small proof of work in the
 * background while the person types, so sending is instant. Pair it with <Honeypot /> inside the form.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/web/lib/api";
import { SHIELD_HONEYPOT_NAME, solveWork, type ShieldAnswer, type ShieldChallenge } from "@/shared/spam-shield";

export function useShield(form: string) {
  const [hp, setHp] = useState("");
  const job = useRef<Promise<{ challenge: ShieldChallenge; nonce: number } | null> | null>(null);
  const start = useCallback(() => {
    job.current = (async () => {
      try {
        const { challenge } = await api.get<{ challenge: ShieldChallenge }>(`/pub/booking/shield?form=${form}`);
        return { challenge, nonce: await solveWork(challenge.salt, challenge.difficulty) };
      } catch {
        return null;
      }
    })();
  }, [form]);
  useEffect(() => { start(); }, [start]);
  /** The answer to send with the form. Starts a fresh challenge for the next send (each works once). */
  const answer = useCallback(async (): Promise<ShieldAnswer | undefined> => {
    if (!job.current) start();
    const got = await job.current;
    start();
    return got ? { ...got, hp } : undefined;
  }, [hp, start]);
  return { answer, honeypot: { value: hp, onChange: setHp } };
}

/** A field people never see or reach; scripts that fill every field give themselves away. */
export function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden">
      <label>Leave this empty<input type="text" name={SHIELD_HONEYPOT_NAME} tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} /></label>
    </div>
  );
}
