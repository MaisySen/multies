/**
 * Self-host wiring for Stalwart, run after scripts/stalwart-setup.ts (listeners and the
 * provisioner). Talks to Stalwart only through its management API. Safe to re-run.
 *
 *  1. Server name: defaultHostname = MAIL_CLIENT_HOST (SMTP greeting, certificates).
 *  2. Inbound: an MTA Hook at the DATA stage for sessions that are not signed in, pointing
 *     at the mail bridge (scripts/selfhost/mail-bridge.ts), which hands the message to Multies.
 *  3. Port 25 takes mail for any domain, because Multies, not Stalwart, knows which domains
 *     and mailboxes exist. Only the hook decides: it never lets an unauthenticated message
 *     relay out (it answers discard or reject, never accept).
 *  4. Multies' sending account (SMTP_USER) may send as any address Multies hosts.
 *
 * Env: STALWART_URL, STALWART_RECOVERY_ADMIN (user:password), MAIL_OPS_DOMAIN, MAIL_CLIENT_HOST,
 *      MTA_HOOK_TOKEN, BRIDGE_URL (default http://mail-bridge:8025/hook), SMTP_USER, SMTP_PASS.
 */
import { StalwartClient } from "../../src/server/services/mailserver/stalwart";

type Expr = { match: Record<string, { if: string; then: string }>; else: string };

export function hookObject(url: string, token: string) {
  return {
    url,
    stages: { data: true },
    enable: { match: { 0: { if: "is_empty(authenticated_as)", then: "true" } }, else: "false" },
    tempFailOnError: true,
    timeout: 30000,
    allowInvalidCerts: false,
    httpHeaders: {},
    httpAuth: { "@type": "Bearer", bearerToken: { "@type": "Value", secret: token } },
  };
}

export const relayExpr: Expr = { match: { 0: { if: "local_port == 25", then: "true" } }, else: "!is_empty(authenticated_as)" };

export function senderExpr(relayLogin: string): Expr {
  if (!/^[a-z0-9._+-]+@[a-z0-9.-]+$/i.test(relayLogin)) throw new Error("SMTP_USER must be an address like mymail-relay@ops.example.com");
  return { match: { 0: { if: `authenticated_as == '${relayLogin.toLowerCase()}'`, then: "false" } }, else: "true" };
}

async function main() {
  const env = process.env;
  const need = (k: string) => { const v = env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(1); } return v; };
  const [rUser, ...rest] = need("STALWART_RECOVERY_ADMIN").split(":");
  const opsDomain = need("MAIL_OPS_DOMAIN").toLowerCase();
  const host = need("MAIL_CLIENT_HOST");
  const token = need("MTA_HOOK_TOKEN");
  const bridgeUrl = env.BRIDGE_URL ?? "http://mail-bridge:8025/hook";
  const relayLogin = need("SMTP_USER").toLowerCase();
  const relaySecret = need("SMTP_PASS");
  if (token.length < 24 || relaySecret.length < 24) { console.error("MTA_HOOK_TOKEN and SMTP_PASS must be at least 24 characters."); process.exit(1); }
  const [relayLocal, relayDomain] = relayLogin.split("@");
  if (relayDomain !== opsDomain) { console.error(`SMTP_USER must be an address at ${opsDomain}.`); process.exit(1); }

  const client = new StalwartClient({ url: need("STALWART_URL"), admin: { user: rUser, secret: rest.join(":") }, fetch });
  const ok = (r: unknown, what: string) => {
    const a = (r as [string, Record<string, Record<string, { description?: string; type?: string; validationErrors?: unknown }>>])[1];
    const bad = a.notUpdated ?? a.notCreated;
    if (bad && Object.keys(bad).length) { console.error(`${what} refused: ${JSON.stringify(bad)}`); process.exit(1); }
    console.log(`${what}: done`);
  };

  // Recovery mode pauses the search indexer, so look objects up with /get rather than /query.
  const [doms] = await client.call([["x:Domain/get", { ids: null, properties: ["name"] }, "g"]]);
  const domainId = ((doms[1].list as { id: string; name: string }[]) ?? []).find((d) => d.name === opsDomain)?.id ?? await client.ensureDomain(opsDomain);

  // Stalwart wants a full host name; "localhost" (this computer only) becomes mail.<ops domain>.
  const hostname = host.includes(".") ? host : `mail.${opsDomain}`;
  const [sys] = await client.call([["x:SystemSettings/set", { update: { singleton: { defaultHostname: hostname, defaultDomainId: domainId } } }, "s"]]);
  ok(sys, "server name");

  const [accts] = await client.call([["x:Account/get", { ids: null, properties: ["name", "domainId"] }, "g"]]);
  const relayId = ((accts[1].list as { id: string; name: string; domainId: string }[]) ?? []).find((a) => a.name === relayLocal && a.domainId === domainId)?.id;
  if (relayId) {
    const [r] = await client.call([["x:Account/set", { update: { [relayId]: { credentials: { 0: { "@type": "Password", secret: relaySecret } } } } }, "s"]]);
    ok(r, "sending account (updated)");
  } else {
    await client.createUser({ localPart: relayLocal, domainId, secret: relaySecret, description: "Multies sending (do not delete)" });
    console.log("sending account: created");
  }

  const [hooks] = await client.call([["x:MtaHook/get", { ids: null, properties: ["url"] }, "g"]]);
  const hookId = ((hooks[1].list as { id: string; url: string }[]) ?? []).find((h) => h.url === bridgeUrl)?.id;
  const [h] = await client.call([["x:MtaHook/set", hookId ? { update: { [hookId]: hookObject(bridgeUrl, token) } } : { create: { h: hookObject(bridgeUrl, token) } }, "s"]]);
  ok(h, "inbound hook");

  const [rcpt] = await client.call([["x:MtaStageRcpt/set", { update: { singleton: { allowRelaying: relayExpr } } }, "s"]]);
  ok(rcpt, "port 25 recipients");
  const [auth] = await client.call([["x:MtaStageAuth/set", { update: { singleton: { mustMatchSender: senderExpr(relayLogin) } } }, "s"]]);
  ok(auth, "sender rule");
  console.log("Stalwart is wired to Multies. Restart it without STALWART_RECOVERY_MODE.");
}

const isMain = process.argv[1] && /selfhost[/\\]stalwart\.(ts|js)$|selfhost-stalwart\.js$/.test(process.argv[1]);
if (isMain) await main();
