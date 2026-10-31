/**
 * R87: a workspace's own link domain, a name under one of its verified domains (go.example.com). The name needs a CNAME
 * to the link host and a certificate on our side before links use it; until then links use <app>/l.
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { domains, linkHosts } from "../../db/schema";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import type { LinkHostInfo } from "@/shared/links";
import { forgetHost } from "./public";

export const LINK_HOST_TARGET = "links.multies.si";
const SUB_RE = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

export async function getHost(deps: Deps, auth: AuthContext): Promise<LinkHostInfo> {
  const [h, verified] = await Promise.all([
    deps.db.select().from(linkHosts).where(eq(linkHosts.orgId, auth.orgId)).get(),
    deps.db.select({ id: domains.id, name: domains.name }).from(domains).where(and(eq(domains.orgId, auth.orgId), eq(domains.status, "verified"))),
  ]);
  const def = `${deps.config.appUrl.replace(/\/+$/, "")}/l`;
  return {
    host: h?.host ?? null, status: h?.status ?? "none", defaultBase: def, base: h?.status === "live" ? `https://${h.host}` : def,
    verifiedDomains: verified, canEdit: auth.role !== "member", target: LINK_HOST_TARGET,
  };
}

export async function setHost(deps: Deps, auth: AuthContext, input: { domainId: string; sub: string }): Promise<LinkHostInfo> {
  if (auth.role === "member") throw forbidden("Only admins can change the link domain.");
  const sub = String(input.sub ?? "").trim().toLowerCase();
  if (!SUB_RE.test(sub)) throw badRequest("Use letters, numbers or - for the name before your domain (like go).");
  const d = await deps.db.select({ id: domains.id, name: domains.name, status: domains.status }).from(domains).where(and(eq(domains.id, String(input.domainId ?? "")), eq(domains.orgId, auth.orgId))).get();
  if (!d) throw notFound("Domain");
  if (d.status !== "verified") throw badRequest("Verify this domain in Domains first.");
  const host = `${sub}.${d.name}`;
  const old = await deps.db.select().from(linkHosts).where(eq(linkHosts.orgId, auth.orgId)).get();
  try {
    if (old) await deps.db.update(linkHosts).set({ host, domainId: d.id, status: "pending", checkedAt: null }).where(eq(linkHosts.orgId, auth.orgId));
    else await deps.db.insert(linkHosts).values({ orgId: auth.orgId, host, domainId: d.id, status: "pending", createdAt: deps.now() });
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? "") + String((e as { cause?: Error })?.cause?.message ?? ""))) throw conflict("That name is already used for links by another workspace.");
    throw e;
  }
  if (old) await forgetHost(old.host);
  return getHost(deps, auth);
}

/** Looks up the CNAME over DNS over HTTPS. DNS right moves the state on; going live needs the certificate on our side. */
export async function checkHost(deps: Deps, auth: AuthContext): Promise<LinkHostInfo> {
  if (auth.role === "member") throw forbidden("Only admins can check the link domain.");
  const h = await deps.db.select().from(linkHosts).where(eq(linkHosts.orgId, auth.orgId)).get();
  if (!h) throw notFound("Link domain");
  let ok: boolean;
  try {
    const res = await deps.fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h.host)}&type=CNAME`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    ok = (body.Answer ?? []).some((a) => a.type === 5 && a.data.replace(/\.$/, "").toLowerCase() === LINK_HOST_TARGET);
  } catch { ok = false; }
  const status = ok ? (h.status === "live" ? "live" : "dns_ok") : "pending";
  await deps.db.update(linkHosts).set({ status, checkedAt: deps.now() }).where(eq(linkHosts.orgId, auth.orgId));
  return getHost(deps, auth);
}

export async function removeHost(deps: Deps, auth: AuthContext): Promise<LinkHostInfo> {
  if (auth.role === "member") throw forbidden("Only admins can change the link domain.");
  const h = await deps.db.select().from(linkHosts).where(eq(linkHosts.orgId, auth.orgId)).get();
  if (h) { await deps.db.delete(linkHosts).where(eq(linkHosts.orgId, auth.orgId)); await forgetHost(h.host); }
  return getHost(deps, auth);
}
