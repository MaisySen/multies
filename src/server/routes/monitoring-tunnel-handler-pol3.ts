import type { Context } from "hono";
import type { AppEnv } from "../context";
import { RateLimiter } from "../lib/rate-limit";

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
  let upstream: Response;
  try {
    const send = c.var.deps?.fetch ?? fetch;
    upstream = await send(`https://${ours.host}/api/${ours.projectId}/envelope/`, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: buf,
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
