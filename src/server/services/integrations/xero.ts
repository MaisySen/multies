/**
 * Xero, behind config: with XERO_CLIENT_ID and XERO_CLIENT_SECRET set, a workspace admin can
 * connect Xero (OAuth 2.0, read only) so invoice reminders list unpaid invoices to chase.
 * Tokens are encrypted with APP_SECRET and refreshed as they expire.
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { integrations } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { decryptSecret, encryptSecret, newId, randomToken } from "../../lib/crypto";
import { audit } from "../audit";

const AUTHORIZE = "https://login.xero.com/identity/connect/authorize";
const TOKEN = "https://identity.xero.com/connect/token";
const SCOPES = "openid profile email offline_access accounting.transactions.read accounting.contacts.read";

interface Tokens { access_token: string; refresh_token: string; expires_in: number }

function client(deps: Deps) {
  if (!deps.config.xero) throw new HttpError(404, "xero_off", "Xero isn't set up on this Multies.");
  return deps.config.xero;
}

export function xeroConfigured(deps: Deps) { return !!deps.config.xero; }

export function authorizeUrl(deps: Deps, redirectUri: string) {
  const c = client(deps);
  const state = randomToken(16);
  const u = new URL(AUTHORIZE);
  u.search = new URLSearchParams({ response_type: "code", client_id: c.clientId, redirect_uri: redirectUri, scope: SCOPES, state }).toString();
  return { url: u.toString(), state };
}

async function tokenRequest(deps: Deps, body: Record<string, string>): Promise<Tokens> {
  const c = client(deps);
  const res = await deps.fetch(TOKEN, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`${c.clientId}:${c.clientSecret}`)}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new HttpError(502, "xero_failed", `Xero refused the sign in (${res.status}). Try connecting again.`);
  return (await res.json()) as Tokens;
}

export async function connect(deps: Deps, auth: AuthContext, code: string, redirectUri: string) {
  const t = await tokenRequest(deps, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const conns = await deps.fetch("https://api.xero.com/connections", { headers: { authorization: `Bearer ${t.access_token}` } });
  const tenants = conns.ok ? ((await conns.json()) as { tenantId: string; tenantName: string; tenantType: string }[]).filter((x) => x.tenantType === "ORGANISATION") : [];
  if (!tenants.length) throw new HttpError(422, "xero_no_org", "That Xero login has no organisation we can read.");
  const values = {
    tenantId: tenants[0].tenantId, tenantName: tenants[0].tenantName, tokensEnc: await encryptSecret(deps.config.appSecret, JSON.stringify(t)),
    expiresAt: new Date(deps.now().getTime() + (t.expires_in - 60) * 1000), connectedByUserId: auth.userId || null,
  };
  await deps.db.insert(integrations).values({ id: newId("int"), orgId: auth.orgId, provider: "xero", ...values })
    .onConflictDoUpdate({ target: [integrations.orgId, integrations.provider], set: values });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "integration.connected", targetType: "integration", targetId: "xero", metadata: { provider: "xero", organisation: tenants[0].tenantName } });
  return { tenantName: tenants[0].tenantName };
}

export async function status(deps: Deps, orgId: string) {
  if (!deps.config.xero) return { configured: false, connected: false as const };
  const row = await deps.db.select().from(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.provider, "xero"))).get();
  return { configured: true, connected: !!row, tenantName: row?.tenantName ?? null };
}

export async function disconnect(deps: Deps, auth: AuthContext) {
  await deps.db.delete(integrations).where(and(eq(integrations.orgId, auth.orgId), eq(integrations.provider, "xero")));
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "integration.disconnected", targetType: "integration", targetId: "xero" });
}

async function accessToken(deps: Deps, orgId: string) {
  const row = await deps.db.select().from(integrations).where(and(eq(integrations.orgId, orgId), eq(integrations.provider, "xero"))).get();
  if (!row) throw notFound("Xero connection");
  let t = JSON.parse(await decryptSecret(deps.config.appSecret, row.tokensEnc)) as Tokens;
  if (!row.expiresAt || row.expiresAt.getTime() <= deps.now().getTime()) {
    t = await tokenRequest(deps, { grant_type: "refresh_token", refresh_token: t.refresh_token });
    await deps.db.update(integrations).set({ tokensEnc: await encryptSecret(deps.config.appSecret, JSON.stringify(t)), expiresAt: new Date(deps.now().getTime() + (t.expires_in - 60) * 1000) }).where(eq(integrations.id, row.id));
  }
  return { token: t.access_token, tenantId: row.tenantId! };
}

/** Unpaid sales invoices, most overdue first, shaped for the reminder form. */
export async function unpaidInvoices(deps: Deps, orgId: string) {
  const { token, tenantId } = await accessToken(deps, orgId);
  const where = encodeURIComponent('Type=="ACCREC"&&Status=="AUTHORISED"&&AmountDue>0');
  const res = await deps.fetch(`https://api.xero.com/api.xro/2.0/Invoices?where=${where}&order=DueDate&summaryOnly=true`, {
    headers: { authorization: `Bearer ${token}`, "xero-tenant-id": tenantId, accept: "application/json" },
  });
  if (!res.ok) throw new HttpError(502, "xero_failed", `Xero didn't answer (${res.status}).`);
  const body = (await res.json()) as { Invoices?: { InvoiceNumber: string; AmountDue: number; CurrencyCode: string; DueDateString?: string; DueDate?: string; Contact: { Name: string; EmailAddress?: string } }[] };
  return (body.Invoices ?? []).map((i) => ({
    invoiceNumber: i.InvoiceNumber, customerName: i.Contact.Name, email: i.Contact.EmailAddress ?? null, amount: i.AmountDue, currency: i.CurrencyCode,
    dueDate: (i.DueDateString ?? "").slice(0, 10) || xeroDate(i.DueDate),
  }));
}

/** Xero's "/Date(1729123200000+0000)/" to "2024-10-17". */
function xeroDate(v?: string) {
  const ms = Number(v?.match(/\d+/)?.[0]);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
}
