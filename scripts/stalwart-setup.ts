/**
 * One-time (and safe to re-run) setup of a Stalwart mail server for Multies:
 * network listeners for IMAP and SMTP, the operations domain, and the provisioner
 * account Multies uses to create mailboxes. Run it against a server started in
 * recovery mode (STALWART_RECOVERY_MODE=1) with STALWART_RECOVERY_ADMIN set.
 *
 *   STALWART_URL=http://localhost:8080 STALWART_RECOVERY_ADMIN=admin:... \
 *   MAIL_OPS_DOMAIN=ops.example.com STALWART_ADMIN_SECRET=... npx tsx scripts/stalwart-setup.ts
 *
 * Prints the STALWART_ADMIN_USER to give Multies. Never prints secrets.
 */
import { StalwartClient } from "../src/server/services/mailserver/stalwart";

const env = process.env;
const need = (k: string) => { const v = env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(1); } return v; };
const url = need("STALWART_URL");
const [rUser, ...rest] = need("STALWART_RECOVERY_ADMIN").split(":");
const opsDomain = need("MAIL_OPS_DOMAIN");
const provisionerSecret = need("STALWART_ADMIN_SECRET");
if (provisionerSecret.length < 24) { console.error("STALWART_ADMIN_SECRET must be at least 24 characters."); process.exit(1); }
const bindHost = env.STALWART_BIND ?? "[::]";

// Standard ports. Behind a TLS-terminating proxy, or for local tests, override with LISTENERS=json.
const listeners: { name: string; port: number; protocol: string; tlsImplicit?: boolean }[] = env.LISTENERS ? JSON.parse(env.LISTENERS) : [
  { name: "http", port: 8080, protocol: "http" },
  { name: "smtp", port: 25, protocol: "smtp" },
  { name: "submissions", port: 465, protocol: "smtp", tlsImplicit: true },
  { name: "submission", port: 587, protocol: "smtp" },
  { name: "imaps", port: 993, protocol: "imap", tlsImplicit: true },
];

const client = new StalwartClient({ url, admin: { user: rUser, secret: rest.join(":") }, fetch });

const [existing] = await client.call([["x:NetworkListener/get", { ids: null }, "g"]]);
const have = new Set(((existing[1].list as { name: string }[]) ?? []).map((l) => l.name));
const create: Record<string, unknown> = {};
for (const l of listeners) {
  if (have.has(l.name)) continue;
  create[l.name] = { name: l.name, bind: { [`${bindHost}:${l.port}`]: true }, protocol: l.protocol, ...(l.tlsImplicit ? { tlsImplicit: true } : {}) };
}
if (Object.keys(create).length) {
  const [r] = await client.call([["x:NetworkListener/set", { create }, "s"]]);
  const failed = (r[1].notCreated ?? {}) as Record<string, unknown>;
  if (Object.keys(failed).length) { console.error("Listeners refused:", JSON.stringify(failed)); process.exit(1); }
  console.log(`listeners created: ${Object.keys(create).join(", ")}`);
} else {
  console.log("listeners: already set up");
}

// Recovery mode pauses the search indexer, so look objects up with /get rather than /query.
const [doms] = await client.call([["x:Domain/get", { ids: null, properties: ["name"] }, "g"]]);
const domainId = ((doms[1].list as { id: string; name: string }[]) ?? []).find((d) => d.name === opsDomain)?.id ?? await client.ensureDomain(opsDomain);
const name = "mymail-provisioner";
const [accts] = await client.call([["x:Account/get", { ids: null, properties: ["name", "domainId"] }, "g"]]);
const found = ((accts[1].list as { id: string; name: string; domainId: string }[]) ?? []).find((a) => a.name === name && a.domainId === domainId)?.id;
if (found) {
  const [r] = await client.call([["x:Account/set", { update: { [found]: { credentials: { 0: { "@type": "Password", secret: provisionerSecret } }, roles: { "@type": "Admin" } } } }, "s"]]);
  const refused = (r[1].notUpdated as Record<string, { description?: string }> | undefined)?.[found];
  if (refused) { console.error(`Provisioner update refused: ${refused.description ?? "unknown"}`); process.exit(1); }
  console.log("provisioner: updated");
} else {
  const user = {
    "@type": "User", name, domainId, description: "Multies provisioning (do not delete)",
    credentials: { 0: { "@type": "Password", secret: provisionerSecret } }, memberGroupIds: {},
    roles: { "@type": "Admin" }, permissions: { "@type": "Inherit" }, quotas: {}, aliases: {}, encryptionAtRest: { "@type": "Disabled" },
  };
  const [r] = await client.call([["x:Account/set", { create: { p: user } }, "s"]]);
  StalwartClient.created(r, "p"); // throws with the server's reason, e.g. a weak password
  console.log("provisioner: created");
}
console.log(`STALWART_ADMIN_USER=${name}@${opsDomain}`);
