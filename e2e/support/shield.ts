import type { APIRequestContext } from "@playwright/test";
import { SHIELD_MIN_FILL_MS, solveWork, type ShieldAnswer, type ShieldChallenge } from "../../src/shared/spam-shield";

/**
 * R92: answers for the spam shield on public forms, the way the browser makes them (signed challenge, proof of work,
 * empty honeypot), for specs that post to public forms through the API. Fetches n challenges, solves them, and waits
 * out the minimum fill time once. Each answer works once.
 */
export async function shieldAnswers(request: APIRequestContext, form: "book" | "poll" | "event", n: number, headers: Record<string, string> = {}): Promise<ShieldAnswer[]> {
  const out: ShieldAnswer[] = [];
  for (let i = 0; i < n; i++) {
    const r = await request.get(`/api/pub/booking/shield?form=${form}`, { headers });
    const { challenge } = (await r.json()) as { challenge: ShieldChallenge };
    out.push({ challenge, nonce: await solveWork(challenge.salt, challenge.difficulty), hp: "" });
  }
  await new Promise((r) => setTimeout(r, SHIELD_MIN_FILL_MS + 300));
  return out;
}
