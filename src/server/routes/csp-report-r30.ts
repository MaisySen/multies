import type { Hono } from "hono";
import type { AppEnv } from "../context";
import { CSP_REPORT_PATH } from "../lib/security-headers";

/**
 * R30: where browsers send Content Security Policy violation reports (report-uri and the
 * Reporting API's report-to). It only logs: no database rows (D1 writes are budgeted account
 * wide) and no limiter writes. Each isolate logs at most LOG_PER_MINUTE reports a minute and
 * drops the rest; bodies over MAX_BODY bytes are dropped unread. Always answers 204.
 */
export const LOG_PER_MINUTE = 30;
const MAX_BODY = 16_384;

export interface CspViolation { directive: string; blocked: string; page: string; source: string }

/** Keeps the origin and path of a URL (no query or fragment, which can carry tokens). */
export function trimUrl(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return v.slice(0, 40); // "inline", "eval", "data", "blob"
  try {
    const u = new URL(v);
    if (u.protocol === "data:" || u.protocol === "blob:") return u.protocol.slice(0, -1);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return "";
  }
}

/** Both report shapes: application/csp-report ({"csp-report": {...}}) and application/reports+json ([{type, body}]). */
export function parseCspReports(raw: string): CspViolation[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  const bodies: Record<string, unknown>[] = [];
  if (Array.isArray(data)) {
    for (const r of data.slice(0, 20)) {
      const rec = r as { type?: unknown; body?: unknown };
      if (rec && rec.type === "csp-violation" && rec.body && typeof rec.body === "object") bodies.push(rec.body as Record<string, unknown>);
    }
  } else if (data && typeof data === "object" && (data as Record<string, unknown>)["csp-report"]) {
    bodies.push((data as Record<string, Record<string, unknown>>)["csp-report"]);
  }
  return bodies.map((b) => ({
    directive: String(b.effectiveDirective ?? b["effective-directive"] ?? b["violated-directive"] ?? "").slice(0, 40),
    blocked: trimUrl(b.blockedURL ?? b["blocked-uri"]),
    page: (() => { const u = trimUrl(b.documentURL ?? b["document-uri"]); try { return new URL(u).pathname; } catch { return u; } })(),
    source: trimUrl(b.sourceFile ?? b["source-file"]),
  }));
}

let windowStart = 0;
let logged = 0;

/** For tests: start a fresh minute. */
export function resetCspReportWindow() { windowStart = 0; logged = 0; }

export function installCspReport(app: Hono<AppEnv>) {
  app.post(CSP_REPORT_PATH, async (c) => {
    const size = Number(c.req.header("content-length") ?? "0");
    if (size > MAX_BODY) return c.body(null, 204);
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; logged = 0; }
    if (logged >= LOG_PER_MINUTE) return c.body(null, 204);
    const raw = (await c.req.text().catch(() => "")).slice(0, MAX_BODY);
    for (const v of parseCspReports(raw)) {
      if (logged >= LOG_PER_MINUTE) break;
      logged++;
      (c.var.log?.warn ?? console.warn)("csp_violation", v as unknown as Record<string, unknown>);
    }
    return c.body(null, 204);
  });
}
