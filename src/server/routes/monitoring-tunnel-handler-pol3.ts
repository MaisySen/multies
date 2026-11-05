import type { Context } from "hono";
import type { AppEnv } from "../context";
import { RateLimiter } from "../lib/rate-limit";
import { envelopeItemAllowed } from "../../shared/sentry-scrub";

/**
 * POL3: forwards one error tracker envelope from the signed in app to the tracker's ingest host, server side.
 * Checks before anything leaves: the body is at most MAX_BODY bytes, the envelope header names exactly our web
 * DSN (host, project and public key), and the caller is inside its per minute share (per address and per isolate).
 * Nothing is stored or logged beyond a counter line; cookies and the caller's headers are never forwarded.
 */
export const MAX_BODY = 200_000;
export const PER_IP_PER_MINUTE = 30;
export const PER_ISOLATE_PER_MINUTE = 600;
const FORWARD_TIMEOUT_MS = 5_000;

let perIp = new RateLimiter(PER_IP_PER_MINUTE, 60_000);
let perIsolate = new RateLimiter(PER_ISOLATE_PER_MINUTE, 60_000);

/** For tests: fresh limits (optionally with a fake clock). */
export function resetMonitoringTunnelLimits(now: () => number = Date.now) {
  perIp = new RateLimiter(PER_IP_PER_MINUTE, 60_000, now);
  perIsolate = new RateLimiter(PER_ISOLATE_PER_MINUTE, 60_000, now);
}

export interface ParsedDsn { host: string; projectId: string; publicKey: string }

/** https://<publicKey>@<host>/<projectId> → its parts; null for anything else (https only, no path prefix). */
export function parseDsn(dsn: string | null | undefined): ParsedDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, "");
    if (u.protocol !== "https:" || !u.username || !/^\d+$/.test(projectId)) return null;
    return { host: u.host.toLowerCase(), projectId, publicKey: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

/** The envelope's first line is a JSON header carrying the DSN it was built for. */
export function envelopeDsn(body: string): ParsedDsn | null {
  const nl = body.indexOf("\n");
  const first = nl < 0 ? body : body.slice(0, nl);
  if (first.length > 4_096) return null;
  try {
    const head = JSON.parse(first) as { dsn?: unknown };
    return typeof head?.dsn === "string" ? parseDsn(head.dsn) : null;
  } catch {
    return null;
  }
}

export const sameDsn = (a: ParsedDsn | null, b: ParsedDsn | null) => !!a && !!b && a.host === b.host && a.projectId === b.projectId && a.publicKey === b.publicKey;

/**
 * POL5: rebuilds the envelope with only allowed item types (no attachment, replay or profile ever reaches the
 * tracker). Items with a length header are skipped by byte count; others run to the next newline. Returns null
 * when the envelope cannot be read, and the kept bytes otherwise (possibly with no items).
 */
export function filterEnvelopeBytes(buf: Uint8Array): { body: Uint8Array; kept: number; dropped: number } | null {
  const dec = new TextDecoder();
  const lineEnd = (from: number) => { const i = buf.indexOf(10, from); return i < 0 ? buf.length : i; };
  const headEnd = lineEnd(0);
  const parts: Uint8Array[] = [buf.subarray(0, Math.min(headEnd + 1, buf.length))];
  let pos = headEnd + 1, kept = 0, dropped = 0;
  while (pos < buf.length) {
    const hEnd = lineEnd(pos);
    const headText = dec.decode(buf.subarray(pos, hEnd)).trim();
    if (!headText) { pos = hEnd + 1; continue; }
    let head: { type?: unknown; length?: unknown };
    try { head = JSON.parse(headText); } catch { return null; }
    if (!head || typeof head !== "object") return null;
    const start = hEnd + 1;
    let end: number;
    if (typeof head.length === "number" && Number.isInteger(head.length) && head.length >= 0) {
      end = start + head.length;
      if (end > buf.length) return null;
    } else end = lineEnd(start);
    const next = Math.min(end + 1, buf.length);
    if (envelopeItemAllowed(head.type)) { parts.push(buf.subarray(pos, next)); kept++; } else dropped++;
    pos = next;
  }
  if (dropped === 0) return { body: buf, kept, dropped };
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { body.set(p, o); o += p.length; }
  return { body, kept, dropped };
}

const PASS_HEADERS = ["retry-after", "x-sentry-rate-limits"];

export async function handleMonitoringTunnel(c: Context<AppEnv>): Promise<Response> {
  const ours = parseDsn(c.var.deps?.config?.sentry?.dsnWeb);
  if (!ours) return c.body(null, 404);
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BODY) return c.body(null, 413);
  if (!perIsolate.take("all") || !perIp.take(c.var.ip ?? "unknown")) {
    c.header("retry-after", "60");
    return c.body(null, 429);
  }
  const buf = await c.req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength === 0) return c.body(null, 400);
  if (buf.byteLength > MAX_BODY) return c.body(null, 413);
  const text = new TextDecoder().decode(buf);
  if (!sameDsn(envelopeDsn(text), ours)) return c.body(null, 400);
  const filtered = filterEnvelopeBytes(new Uint8Array(buf));
  if (!filtered) return c.body(null, 400);
  if (filtered.kept === 0) return c.body(null, 200);
  let upstream: Response;
  try {
    const send = c.var.deps?.fetch ?? fetch;
    upstream = await send(`https://${ours.host}/api/${ours.projectId}/envelope/`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: filtered.body as unknown as BodyInit,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch {
    return c.body(null, 502);
  }
  await upstream.body?.cancel().catch(() => undefined);
  const res = new Response(null, { status: upstream.status === 200 ? 200 : upstream.status === 429 ? 429 : upstream.ok ? 200 : 502 });
  for (const h of PASS_HEADERS) { const v = upstream.headers.get(h); if (v) res.headers.set(h, v); }
  res.headers.set("cache-control", "no-store");
  return res;
}
