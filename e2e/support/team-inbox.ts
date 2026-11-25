import path from "node:path";
import Database from "better-sqlite3";
import { expect, type Page } from "@playwright/test";
import { sign } from "../../email-worker/src/index";

/**
 * Since invites are off in the demo workspace (MB-220, DEMO_INVITES_OFF), a spec that needs teammates and a shared
 * inbox makes its own workspace: the owner signs up (straight into the app), the workspace goes on a paid plan, gets a
 * domain with the mailboxes asked for, and customer mail arrives through the signed inbound webhook. The local server
 * has no DNS to check, so the domain is marked verified in the E2E database (as crm-td10 and mail-r31 write there);
 * mail only routes to a verified domain (PRIV1b P36).
 */
export interface TeamInbox { origin: string; headers: { origin: string }; ownerName: string; mailboxes: Record<string, { id: string; address: string }> }

export async function teamInbox(page: Page, opts: { ownerName: string; mailboxes: string[] }): Promise<TeamInbox> {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(opts.ownerName);
  await page.getByLabel("Work email").fill(`owner-${tag}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  expect((await page.request.post("/api/org/plan", { data: { plan: "pro" }, headers })).status()).toBe(200);
  const domain = await page.request.post("/api/domains", { data: { name: `team-${tag}.test` }, headers });
  expect(domain.status()).toBe(201);
  const domainId = (await domain.json()).domain.id as string;
  expect(process.env.E2E_BASE_URL, "teamInbox needs the local E2E server (it marks the domain verified in its database)").toBeFalsy();
  const db = new Database(path.resolve(".data/e2e.db"), { fileMustExist: true });
  try { db.prepare("update domains set status = 'verified', verified_at = ? where id = ?").run(Date.now(), domainId); } finally { db.close(); }
  const mailboxes: TeamInbox["mailboxes"] = {};
  for (const localPart of opts.mailboxes) {
    const r = await page.request.post("/api/mailboxes", { data: { domainId, localPart, displayName: localPart[0].toUpperCase() + localPart.slice(1) }, headers });
    expect(r.status(), `mailbox ${localPart}`).toBe(201);
    const m = (await r.json()).mailbox as { id: string; address: string };
    mailboxes[localPart] = { id: m.id, address: m.address };
  }
  return { origin, headers, ownerName: opts.ownerName, mailboxes };
}

/** One customer email to `to`, through the signed inbound webhook. Returns once the server accepted it. */
export async function receiveMail(page: Page, team: TeamInbox, to: string, mail: { from: string; fromName: string; subject: string; text: string }) {
  const key = (await (await page.request.post("/api/inbound-keys", { headers: team.headers })).json()).key as { id: string; secret: string };
  const raw = [`From: ${mail.fromName} <${mail.from}>`, `To: ${to}`, `Subject: ${mail.subject}`, `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@customer.example>`,
    `Date: ${new Date().toUTCString()}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", mail.text, ""].join("\r\n");
  const body = new TextEncoder().encode(raw);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = await sign(key.secret, ts, mail.from, to, body.buffer as ArrayBuffer);
  const r = await page.request.post("/api/inbound/cloudflare", {
    headers: { "content-type": "message/rfc822", "x-mymail-key": key.id, "x-mymail-timestamp": ts, "x-mymail-envelope-from": mail.from, "x-mymail-envelope-to": to, "x-mymail-signature": signature },
    data: Buffer.from(body),
  });
  expect((await r.json()).action, `delivered ${mail.subject}`).toBe("accept");
}
