import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type APIRequestContext } from "@playwright/test";

/**
 * R39 security hotfix: accepting an invite needs a confirmed email address, so a spec that signs a
 * teammate up with a password and accepts an invite first opens the confirmation link from the local
 * outbox (OUTBOX_DIR, .data/e2e-outbox). Against a deployed server there is no outbox; it does nothing.
 */
export async function confirmEmail(request: APIRequestContext, address: string, outbox = ".data/e2e-outbox") {
  if (process.env.E2E_BASE_URL) return;
  const find = () => {
    for (const f of readdirSync(outbox).sort().reverse()) {
      const m = JSON.parse(readFileSync(join(outbox, f), "utf8")) as { to: string[]; subject: string; text: string };
      if (m.to.includes(address) && m.subject.includes("Confirm your email")) return m;
    }
    return undefined;
  };
  await expect.poll(() => !!find(), { timeout: 15_000 }).toBe(true);
  const link = find()!.text.match(/https?:\/\/\S+/)![0];
  const res = await request.get(link, { maxRedirects: 0 });
  expect(res.status(), `confirm ${address}`).toBeLessThan(400);
}
