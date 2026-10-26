/**
 * DMARC aggregate (RUA) reports: the XML defined in RFC 7489 appendix C, sent by
 * mailbox providers as .xml, .xml.gz or .zip attachments. Parsed with
 * fast-xml-parser and decompressed with fflate, so it runs on Workers and Node.
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { gunzipSync, unzipSync } from "fflate";
import type { Deps } from "../../context";
import { dmarcRecords, dmarcReports, domains } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest } from "../../lib/errors";

export interface DmarcRow { sourceIp: string; count: number; disposition: string; headerFrom: string | null; dkim: string; spf: string }
export interface ParsedDmarcReport {
  reporter: string;
  reportId: string;
  begin: Date;
  end: Date;
  domain: string;
  policy: { p: string; sp?: string; pct?: number; adkim?: string; aspf?: string };
  rows: DmarcRow[];
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true, isArray: (name) => name === "record" });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());

/** Unwraps gzip or zip if needed and returns the XML text. */
export function extractXml(bytes: Uint8Array): string {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return new TextDecoder().decode(gunzipSync(bytes));
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const name = Object.keys(files).find((n) => n.toLowerCase().endsWith(".xml"));
    if (!name) throw badRequest("The zip file has no XML report inside.");
    return new TextDecoder().decode(files[name]);
  }
  return new TextDecoder().decode(bytes);
}

export function parseDmarcReport(input: Uint8Array | string): ParsedDmarcReport {
  const xml = typeof input === "string" ? input : extractXml(input);
  let doc: Record<string, unknown>;
  try { doc = parser.parse(xml) as Record<string, unknown>; } catch { throw badRequest("That file is not valid XML."); }
  const fb = doc.feedback as Record<string, Record<string, unknown>> | undefined;
  if (!fb?.report_metadata || !fb.policy_published) throw badRequest("That is not a DMARC aggregate report.");
  const meta = fb.report_metadata as Record<string, unknown>;
  const range = (meta.date_range ?? {}) as Record<string, unknown>;
  const pol = fb.policy_published as Record<string, unknown>;
  const rows: DmarcRow[] = arr(fb.record as unknown as Record<string, Record<string, unknown>>[]).map((r) => {
    const row = (r.row ?? {}) as Record<string, unknown>;
    const ev = (row.policy_evaluated ?? {}) as Record<string, unknown>;
    return {
      sourceIp: str(row.source_ip),
      count: Number(str(row.count)) || 0,
      disposition: str(ev.disposition) || "none",
      headerFrom: str((r.identifiers as Record<string, unknown> | undefined)?.header_from) || null,
      dkim: str(ev.dkim) || "fail",
      spf: str(ev.spf) || "fail",
    };
  }).filter((r) => r.sourceIp && r.count > 0);
  const begin = new Date(Number(str(range.begin)) * 1000);
  const end = new Date(Number(str(range.end)) * 1000);
  if (Number.isNaN(begin.getTime()) || Number.isNaN(end.getTime())) throw badRequest("The report has no valid date range.");
  return {
    reporter: str(meta.org_name) || str(meta.email) || "unknown",
    reportId: str(meta.report_id) || `${str(meta.org_name)}-${str(range.begin)}`,
    begin, end,
    domain: str(pol.domain).toLowerCase(),
    policy: {
      p: str(pol.p) || "none",
      ...(pol.sp ? { sp: str(pol.sp) } : {}),
      ...(pol.pct ? { pct: Number(str(pol.pct)) } : {}),
      ...(pol.adkim ? { adkim: str(pol.adkim) } : {}),
      ...(pol.aspf ? { aspf: str(pol.aspf) } : {}),
    },
    rows,
  };
}

/** A message passes DMARC when either aligned DKIM or aligned SPF passed. */
export const rowPasses = (r: Pick<DmarcRow, "dkim" | "spf">) => r.dkim === "pass" || r.spf === "pass";

export const MAX_DMARC_ROWS = 500;

/** Stores a report for the workspace that owns its domain. Duplicate reports are ignored. */
export async function storeDmarcReport(deps: Deps, orgId: string, report: ParsedDmarcReport) {
  const d = await deps.db.select().from(domains).where(and(eq(domains.orgId, orgId), eq(domains.name, report.domain))).get();
  if (!d) throw badRequest(`This report is for ${report.domain || "an unknown domain"}, which is not in this workspace.`);
  const dup = await deps.db.select({ id: dmarcReports.id }).from(dmarcReports)
    .where(and(eq(dmarcReports.orgId, orgId), eq(dmarcReports.reporter, report.reporter), eq(dmarcReports.reportId, report.reportId))).get();
  if (dup) return { id: dup.id, duplicate: true };
  const id = newId("dmr");
  const messages = report.rows.reduce((n, r) => n + r.count, 0);
  const passed = report.rows.filter(rowPasses).reduce((n, r) => n + r.count, 0);
  await deps.db.insert(dmarcReports).values({
    id, orgId, domainId: d.id, reporter: report.reporter, reportId: report.reportId, beginAt: report.begin, endAt: report.end,
    policy: JSON.stringify(report.policy), messages, passed,
  });
  // Reports come from the outside world. Totals count every row, but only the busiest
  // MAX_DMARC_ROWS sources are stored, so one huge report cannot spend the database's daily writes.
  const keep = [...report.rows].sort((a, b) => b.count - a.count).slice(0, MAX_DMARC_ROWS);
  for (let i = 0; i < keep.length; i += 8) {
    await deps.db.insert(dmarcRecords).values(keep.slice(i, i + 8).map((r) => ({ id: newId("dmx"), reportId: id, ...r })));
  }
  return { id, duplicate: false };
}

const looksLikeReport = (a: { filename: string; contentType: string }) =>
  /\.(xml|xml\.gz|gz|zip)$/i.test(a.filename) || /(zip|gzip|xml)/i.test(a.contentType);

/**
 * Called for inbound mail: any attachment that parses as a DMARC aggregate report for
 * one of the workspace's domains is stored. Everything else is ignored quietly.
 */
export async function ingestDmarcAttachments(deps: Deps, orgId: string, attachments: { filename: string; contentType: string; content: Uint8Array }[]) {
  let stored = 0;
  for (const a of attachments.filter(looksLikeReport).slice(0, 5)) {
    try {
      const r = await storeDmarcReport(deps, orgId, parseDmarcReport(a.content));
      if (!r.duplicate) stored++;
    } catch { /* not a report, or not ours */ }
  }
  return stored;
}

/** Summary for the dashboard: recent reports and the sending sources behind them. */
export async function dmarcSummary(deps: Deps, orgId: string, days = 30) {
  const since = new Date(deps.now().getTime() - days * 86400_000);
  const reports = await deps.db.select({ r: dmarcReports, domainName: domains.name }).from(dmarcReports)
    .innerJoin(domains, eq(domains.id, dmarcReports.domainId))
    .where(and(eq(dmarcReports.orgId, orgId), gte(dmarcReports.endAt, since))).orderBy(desc(dmarcReports.endAt)).limit(200);
  const ids = reports.map((x) => x.r.id);
  const records = ids.length ? await deps.db.select().from(dmarcRecords).where(inArray(dmarcRecords.reportId, ids)) : [];
  const byReport = new Map(reports.map((x) => [x.r.id, x]));
  const sources = new Map<string, { sourceIp: string; domain: string; messages: number; passed: number; dkimPass: number; spfPass: number }>();
  for (const rec of records) {
    const rep = byReport.get(rec.reportId)!;
    const key = `${rep.domainName}|${rec.sourceIp}`;
    const s = sources.get(key) ?? { sourceIp: rec.sourceIp, domain: rep.domainName, messages: 0, passed: 0, dkimPass: 0, spfPass: 0 };
    s.messages += rec.count;
    if (rowPasses(rec)) s.passed += rec.count;
    if (rec.dkim === "pass") s.dkimPass += rec.count;
    if (rec.spf === "pass") s.spfPass += rec.count;
    sources.set(key, s);
  }
  return {
    reports: reports.map(({ r, domainName }) => ({
      id: r.id, domain: domainName, reporter: r.reporter, beginAt: r.beginAt, endAt: r.endAt, messages: r.messages, passed: r.passed, policy: JSON.parse(r.policy),
    })),
    sources: [...sources.values()].sort((a, b) => b.messages - a.messages).slice(0, 50),
  };
}
