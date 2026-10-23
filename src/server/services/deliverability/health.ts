/**
 * A 0 to 100 health score per domain, from what decides whether mail lands:
 * DNS authentication records, DMARC policy, DMARC pass rate from aggregate
 * reports, and the bounce and spam complaint rates of mail sent from the domain.
 * Thresholds follow the bulk sender guidance Gmail and Yahoo published in 2024
 * (complaints under 0.3%, ideally under 0.1%).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { deliveries, dmarcReports, domains } from "../../db/schema";

export interface HealthFactor { id: string; label: string; points: number; max: number; status: "good" | "warn" | "bad" | "unknown"; detail: string }

const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const fmt = (n: number) => `${n < 1 ? n.toFixed(2) : n.toFixed(1)}%`;

export async function domainHealth(deps: Deps, orgId: string, d: typeof domains.$inferSelect, days = 30) {
  const since = new Date(deps.now().getTime() - days * 86400_000);
  const report = d.lastCheck ? (JSON.parse(d.lastCheck) as { records: { id: string; status: string; found?: string[]; message?: string }[] }) : null;
  const rec = (id: string) => report?.records.find((r) => r.id === id);
  const factors: HealthFactor[] = [];

  const dnsFactor = (id: string, label: string, max: number, okText: string) => {
    const r = rec(id);
    const status = !r ? "unknown" : r.status === "pass" ? "good" : r.status === "warn" ? "warn" : "bad";
    const points = status === "good" ? max : status === "warn" ? Math.round(max / 2) : 0;
    factors.push({ id, label, max, points, status, detail: !r ? "Not checked yet." : status === "good" ? okText : (r.message ?? "Fix this record on the domain page.") });
  };
  dnsFactor("mx", "MX records", 15, "Inbound mail is routed to MyMail.");
  dnsFactor("spf", "SPF", 15, "Your sending services are authorized.");
  dnsFactor("dkim", "DKIM", 20, "Messages are signed with your key.");
  dnsFactor("dmarc", "DMARC record", 10, "A DMARC policy is published.");

  const dmarcTxt = rec("dmarc")?.found?.find((v) => /v=DMARC1/i.test(v)) ?? "";
  const p = dmarcTxt.match(/\bp=(\w+)/i)?.[1]?.toLowerCase();
  factors.push(p === "reject"
    ? { id: "dmarc_policy", label: "DMARC policy", max: 10, points: 10, status: "good", detail: "p=reject: spoofed mail is refused." }
    : p === "quarantine"
      ? { id: "dmarc_policy", label: "DMARC policy", max: 10, points: 7, status: "good", detail: "p=quarantine: spoofed mail goes to spam. Move to reject once reports look clean." }
      : { id: "dmarc_policy", label: "DMARC policy", max: 10, points: 0, status: p === "none" ? "warn" : "unknown", detail: p === "none" ? "p=none only monitors. Move to quarantine when your reports show your own mail passing." : "No DMARC policy found." });

  const agg = await deps.db.select({ messages: sql<number>`coalesce(sum(${dmarcReports.messages}),0)`, passed: sql<number>`coalesce(sum(${dmarcReports.passed}),0)` })
    .from(dmarcReports).where(and(eq(dmarcReports.domainId, d.id), gte(dmarcReports.endAt, since))).get();
  const reported = Number(agg?.messages ?? 0);
  const passRate = pct(Number(agg?.passed ?? 0), reported);
  factors.push(!reported
    ? { id: "dmarc_pass", label: "DMARC pass rate", max: 15, points: 10, status: "unknown", detail: `No DMARC reports in the last ${days} days. They arrive daily once your DMARC record has a rua address.` }
    : { id: "dmarc_pass", label: "DMARC pass rate", max: 15, points: passRate >= 98 ? 15 : passRate >= 90 ? 10 : passRate >= 75 ? 5 : 0, status: passRate >= 98 ? "good" : passRate >= 90 ? "warn" : "bad", detail: `${fmt(passRate)} of ${reported.toLocaleString("en-US")} reported messages passed.` });

  const suffix = `%@${d.name}`;
  const sent = await deps.db.select({
    total: sql<number>`count(*)`,
    bounced: sql<number>`sum(case when ${deliveries.status} = 'bounced' then 1 else 0 end)`,
    complained: sql<number>`sum(case when ${deliveries.status} = 'complained' then 1 else 0 end)`,
  }).from(deliveries).where(and(eq(deliveries.orgId, orgId), eq(deliveries.direction, "outbound"), gte(deliveries.createdAt, since), sql`${deliveries.fromAddress} like ${suffix}`, sql`${deliveries.provider} <> 'internal'`)).get();
  const total = Number(sent?.total ?? 0);
  const bounceRate = pct(Number(sent?.bounced ?? 0), total);
  const complaintRate = pct(Number(sent?.complained ?? 0), total);
  factors.push(!total
    ? { id: "bounces", label: "Bounce rate", max: 10, points: 10, status: "unknown", detail: `Nothing sent to outside addresses in the last ${days} days.` }
    : { id: "bounces", label: "Bounce rate", max: 10, points: bounceRate < 2 ? 10 : bounceRate < 5 ? 5 : 0, status: bounceRate < 2 ? "good" : bounceRate < 5 ? "warn" : "bad", detail: `${fmt(bounceRate)} of ${total.toLocaleString("en-US")} messages bounced.` });
  factors.push(!total
    ? { id: "complaints", label: "Spam complaints", max: 5, points: 5, status: "unknown", detail: "No complaint data yet." }
    : { id: "complaints", label: "Spam complaints", max: 5, points: complaintRate < 0.1 ? 5 : complaintRate < 0.3 ? 2 : 0, status: complaintRate < 0.1 ? "good" : complaintRate < 0.3 ? "warn" : "bad", detail: `${fmt(complaintRate)} complaint rate. Gmail and Yahoo start filtering above 0.3%.` });

  const score = factors.reduce((n, f) => n + f.points, 0);
  return {
    domainId: d.id, domain: d.name, score,
    grade: score >= 90 ? "healthy" as const : score >= 70 ? "attention" as const : "at_risk" as const,
    factors,
    stats: { sent: total, bounceRate, complaintRate, dmarcMessages: reported, dmarcPassRate: reported ? passRate : null },
  };
}

export async function workspaceHealth(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(domains).where(eq(domains.orgId, orgId)).orderBy(domains.name);
  return Promise.all(rows.map((d) => domainHealth(deps, orgId, d)));
}
