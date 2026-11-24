import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

/**
 * PRIV1b P60: a mailbox connected through a server Multies doesn't recognise (the local Stalwart test server, "Other
 * server") waits for a code emailed to the address. The local server writes that email to its outbox (OUTBOX_DIR,
 * .data/e2e-idp-outbox for the faked identity provider server); this reads the newest code sent to `address`.
 */
export async function connectCode(address: string, outbox = ".data/e2e-idp-outbox"): Promise<string> {
  const find = () => {
    for (const f of readdirSync(outbox).sort().reverse()) {
      const m = JSON.parse(readFileSync(join(outbox, f), "utf8")) as { to: string[]; subject: string; text: string };
      if (m.to.includes(address.toLowerCase()) && m.subject.startsWith(`Your code to connect ${address.toLowerCase()}`)) return m.text.match(/\b(\d{6})\b/)?.[1];
    }
    return undefined;
  };
  await expect.poll(() => !!find(), { timeout: 15_000 }).toBe(true);
  return find()!;
}
