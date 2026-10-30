/**
 * Update health reports (docs/OTA.md, "Health gating"). A small Sentry client over plain fetch, so it
 * needs no native SDK and ships over the air: every report carries the running update id, channel and
 * runtime version as tags, and scripts/ota-health.js reads them back to halt or roll back a rollout.
 *
 * Reports are queued in the on-device store first and sent when the DSN (from GET /api/v1/app-config)
 * is known, so a crash before the config arrives is still reported on the next launch.
 */
import type { KV } from "@/lib/kv";

export type OtaEvent = "applied" | "failed" | "download_failed" | "crash" | "launch_crash";

export type UpdateTags = {
  updateId: string | null;
  channel: string | null;
  runtimeVersion: string | null;
  jsVersion: string;
  nativeVersion: string | null;
  nativeBuild: string | null;
  embedded: boolean;
  os: string;
};

export type Report = {
  event: OtaEvent;
  /** The update the report is about (for "applied" and "crash" the running one). */
  updateId: string | null;
  message: string;
  error?: { type: string; value: string; stack?: string };
  extra?: Record<string, string | number | boolean | null>;
  at: number;
};

const QUEUE = "ota:telemetry:queue";
const MAX_QUEUE = 25;

export function parseDsn(dsn: string): { key: string; host: string; projectId: string } | null {
  const m = dsn.match(/^https:\/\/([0-9a-f]+)@([a-z0-9.-]+)\/(\d+)$/);
  return m ? { key: m[1], host: m[2], projectId: m[3] } : null;
}

export function envelopeUrl(dsn: string): string | null {
  const d = parseDsn(dsn);
  return d ? `https://${d.host}/api/${d.projectId}/envelope/?sentry_key=${d.key}&sentry_version=7&sentry_client=multies-ota%2F1` : null;
}

const hex32 = (rand: () => number = Math.random) => Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join("");

/** Parse a JS stack into Sentry frames (newest last), best effort. */
export function framesFromStack(stack: string | undefined): { function: string; filename: string; lineno?: number; colno?: number }[] {
  if (!stack) return [];
  const out: { function: string; filename: string; lineno?: number; colno?: number }[] = [];
  for (const line of stack.split("\n").slice(0, 50)) {
    const m = line.match(/^\s*(?:at\s+)?([^@(\s]*)\s*[@(]?\s*([^\s()]+?):(\d+):(\d+)\)?\s*$/);
    if (m) out.push({ function: m[1] || "?", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return out.reverse();
}

/** One Sentry event for a report. Pure (event id and clock are passed in). */
export function buildEvent(r: Report, tags: UpdateTags, installId: string, eventId: string) {
  const updateId = r.updateId ?? tags.updateId ?? "embedded";
  const crash = r.event === "crash" || r.event === "launch_crash";
  return {
    event_id: eventId,
    timestamp: r.at / 1000,
    platform: "javascript",
    logger: "ota",
    level: crash ? "fatal" : r.event === "applied" ? "info" : "error",
    environment: `mobile-${tags.channel ?? "dev"}`,
    release: `multies-mobile@${tags.jsVersion}`,
    dist: tags.nativeBuild ?? undefined,
    user: { id: installId },
    tags: {
      app: "mobile",
      ota_event: r.event,
      update_id: updateId,
      running_update_id: tags.updateId ?? "embedded",
      channel: tags.channel ?? "none",
      runtime_version: tags.runtimeVersion ?? "unknown",
      js_version: tags.jsVersion,
      native_version: tags.nativeVersion ?? "unknown",
      native_build: tags.nativeBuild ?? "unknown",
      embedded: String(tags.embedded),
      os: tags.os,
    },
    // Lifecycle events group per update so the Issues list reads as a timeline; crashes group by error.
    fingerprint: crash ? ["ota-crash", updateId, r.error?.type ?? r.message] : ["ota", r.event, updateId],
    message: r.error ? undefined : { formatted: r.message },
    exception: r.error ? { values: [{ type: r.error.type, value: r.error.value, stacktrace: { frames: framesFromStack(r.error.stack) }, mechanism: { type: crash ? "onerror" : "generic", handled: !crash } }] } : undefined,
    extra: r.extra,
  };
}

export function buildEnvelope(event: { event_id: string }, dsn: string, now: number): string {
  return [JSON.stringify({ event_id: event.event_id, sent_at: new Date(now).toISOString(), dsn }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
}

export type Telemetry = {
  record(r: Omit<Report, "at"> & { at?: number }): Promise<void>;
  flush(): Promise<number>;
  setDsn(dsn: string | null, sampleRate?: number): void;
};

/**
 * The client. `store` is the on-device KV, `tags` reads the running app's facts, `send` posts (fetch
 * in the app, a stub in tests). Never throws: telemetry must not break the app it reports on.
 */
export function createTelemetry(o: {
  store: KV;
  tags: () => UpdateTags;
  installId: () => Promise<string>;
  send?: (url: string, body: string) => Promise<boolean>;
  now?: () => number;
  rand?: () => number;
}): Telemetry {
  let dsn: string | null = null;
  let sample = 1;
  const now = o.now ?? Date.now;
  const send = o.send ?? (async (url: string, body: string) => {
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-sentry-envelope" }, body, signal: ctl?.signal });
      return res.ok || res.status === 429 || (res.status >= 400 && res.status < 500);
    } catch { return false; } finally { if (t) clearTimeout(t); }
  });

  const readQueue = async (): Promise<Report[]> => {
    try { const v = await o.store.get(QUEUE); const q = v ? JSON.parse(v) : []; return Array.isArray(q) ? q : []; } catch { return []; }
  };
  const writeQueue = async (q: Report[]) => { try { await o.store.set(QUEUE, JSON.stringify(q.slice(-MAX_QUEUE))); } catch { /* best effort */ } };
  let flushing: Promise<number> | null = null;

  const t: Telemetry = {
    setDsn(d, rate = 1) { dsn = d; sample = rate; },
    async record(r) {
      // Lifecycle reports are always kept (they are the denominator of the crash rate); others are sampled.
      if (r.event !== "applied" && (o.rand ?? Math.random)() > sample) return;
      const q = await readQueue();
      q.push({ ...r, at: r.at ?? now() });
      await writeQueue(q);
      if (dsn) void t.flush();
    },
    async flush() {
      if (!dsn) return 0;
      if (flushing) return flushing;
      flushing = (async () => {
        let sent = 0;
        try {
          const url = envelopeUrl(dsn!);
          if (!url) return 0;
          const q = await readQueue();
          if (!q.length) return 0;
          const tags = o.tags();
          const id = await o.installId();
          const left: Report[] = [];
          for (const r of q) {
            const ev = buildEvent(r, tags, id, hex32(o.rand));
            if (await send(url, buildEnvelope(ev, dsn!, now()))) sent++;
            else left.push(r);
          }
          await writeQueue(left);
          return sent;
        } catch { return sent; } finally { flushing = null; }
      })();
      return flushing;
    },
  };
  return t;
}

/** A random id for this installation, kept in the on-device store (not tied to the person). */
export async function installationId(store: KV, rand: () => number = Math.random): Promise<string> {
  const k = "ota:install-id";
  try {
    const v = await store.get(k);
    if (v) return v;
    const id = hex32(rand);
    await store.set(k, id);
    return id;
  } catch { return "unknown"; }
}
