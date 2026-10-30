import type { Logger } from "../context";
import { maskSecretText } from "../../shared/secret-mask";

type Level = "debug" | "info" | "warn" | "error";

/**
 * Structured logs: one JSON object per line on stdout. Cloudflare Workers Logs and
 * most log pipelines (Logpush, Datadog, Loki, CloudWatch) index the fields as is.
 * Never pass secrets, tokens, passwords or message bodies as fields.
 */
export function jsonLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => console.log(l)): Logger & { child(fields: Record<string, unknown>): Logger } {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...base, ...redact(fields) };
    let line: string;
    try { line = JSON.stringify(rec); } catch { line = JSON.stringify({ ts: rec.ts, level, msg, note: "unserializable fields" }); }
    sink(line);
  };
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => jsonLogger({ ...base, ...fields }, sink),
  };
}

const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|card|cvc/i;

/**
 * Drops values whose key looks like a credential, at any depth, turns errors into plain objects, and masks
 * credential shapes inside strings (an error message can carry a URL with a token or a `client_secret=` pair).
 */
export function redact(fields?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  return redactValue(fields, 0) as Record<string, unknown>;
}

function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") return maskSecretText(v);
  if (v instanceof Error) return { name: v.name, message: maskSecretText(v.message) };
  if (v === null || typeof v !== "object") return v;
  if (depth >= 4) return "[nested]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redactValue(x, depth + 1);
  }
  return out;
}

/** Silent logger for tests. */
export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Uses the edge's id (cf-ray) or a caller's x-request-id when it looks sane; else a new one. */
export function requestIdFrom(headers: Headers): string {
  const given = headers.get("x-request-id") ?? headers.get("cf-ray");
  if (given && REQUEST_ID.test(given)) return given;
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}
