import { describe, it, expect, beforeEach } from "vitest";
import { BINARY_REMOVED, MAX_SPANS, TRACE_BUDGET_BYTES, capTransaction, envelopeItemAllowed, isBinaryValue, scrubEvent, scrubSpan, scrubTransaction, sentryPrivacy, stripBinary } from "../src/shared/sentry-scrub";
import { filterEnvelopeBytes, resetMonitoringTunnelLimits } from "../src/server/routes/monitoring-tunnel-handler-pol3";
import { MONITORING_TUNNEL_PATH } from "../src/server/routes/monitoring-tunnel-pol3";
import { filterEnvelope } from "../src/web/lib/sentry";
import { makeTestApp } from "./helpers";

/** POL5: no binary value, attachment or oversized trace can ever leave in an error report. */
const binaries: [string, () => unknown][] = [
  ["Blob", () => new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" })],
  ["File", () => new File([new Uint8Array([1])], "call.webm", { type: "video/webm" })],
  ["ArrayBuffer", () => new ArrayBuffer(16)],
  ["Uint8Array", () => new Uint8Array(16)],
  ["Float32Array", () => new Float32Array(4)],
  ["DataView", () => new DataView(new ArrayBuffer(8))],
  ["data: string", () => "data:video/webm;base64,GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYEC"],
  ["blob: string", () => "blob:https://multies.si/3f1c0d7e-1111-2222-3333-444455556666"],
];

describe("POL5 binary values", () => {
  for (const [name, make] of binaries) {
    it(`replaces a ${name} in extra, contexts, tags, breadcrumbs and spans`, () => {
      const ev = scrubEvent({
        extra: { chunk: make(), nested: { list: [make()] } },
        contexts: { recorder: { last: make() } },
        tags: { t: make() },
        breadcrumbs: [{ message: "x", data: { blob: make() } }],
        spans: [{ op: "resource.other", description: typeof make() === "string" ? (make() as string) : "ok", data: { body: make() } }],
      });
      expect(isBinaryValue(make())).toBe(true);
      expect(ev.extra.chunk).toBe(BINARY_REMOVED);
      expect((ev.extra.nested as { list: unknown[] }).list[0]).toBe(BINARY_REMOVED);
      expect((ev.contexts.recorder as { last: unknown }).last).toBe(BINARY_REMOVED);
      expect(ev.tags.t).toBe(BINARY_REMOVED);
      expect(ev.breadcrumbs[0].data.blob).toBe(BINARY_REMOVED);
      expect(ev.spans[0].data.body).toBe(BINARY_REMOVED);
      if (typeof make() === "string") expect(ev.spans[0].description).toBe(BINARY_REMOVED);
      const json = JSON.stringify(ev);
      expect(json).not.toMatch(/GkXf|blob:https/);
    });
  }
  it("keeps ordinary values and plain arrays", () => {
    expect(stripBinary({ a: 1, b: "hello", c: [1, "two"], d: null, e: true })).toEqual({ a: 1, b: "hello", c: [1, "two"], d: null, e: true });
    expect(isBinaryValue([1, 2])).toBe(false);
    expect(isBinaryValue("https://multies.si/app")).toBe(false);
  });
  it("is bounded in depth and safe on deep objects", () => {
    let deep: Record<string, unknown> = { leaf: new Uint8Array(4) };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    const out = JSON.stringify(stripBinary(deep));
    expect(out).toContain("[depth limit]");
    expect(out.length).toBeLessThan(1000);
  });
  it("cleans a streamed span", () => {
    const sp = scrubSpan({ op: "x", description: "blob:https://a/b", data: { v: new ArrayBuffer(2) } });
    expect(sp.description).toBe(BINARY_REMOVED);
    expect(sp.data.v).toBe(BINARY_REMOVED);
  });
  it("drops every attachment from the hint", () => {
    const hint = { attachments: [{ filename: "call.webm", data: new Uint8Array(10) }] as unknown[] };
    scrubEvent({ message: "boom" }, hint);
    expect(hint.attachments).toHaveLength(0);
  });
  it("wires the hooks", () => {
    expect(sentryPrivacy.beforeSendTransaction).toBe(scrubTransaction);
    expect(sentryPrivacy.beforeSendSpan).toBe(scrubSpan);
    expect(sentryPrivacy.sendDefaultPii).toBe(false);
  });
});

describe("POL5 trace cap", () => {
  const fake = (n: number, op = (i: number) => (i % 2 ? "ui.long-animation-frame" : "ui.long-task")) => ({
    type: "transaction", transaction: "/app/meetings/:id",
    spans: Array.from({ length: n }, (_, i) => ({ op: op(i), description: "Main UI thread blocked", start_timestamp: i, timestamp: i + 0.1, span_id: `s${i}`, trace_id: "t".repeat(32), data: { "browser.script.invoker": "requestAnimationFrame callback", "browser.script.source_url": "https://multies.si/assets/call.js", i } })),
  });
  it("drops long task and long animation frame spans from a 5000 span transaction", () => {
    const ev = scrubTransaction(fake(5000), {});
    expect(ev.spans).toHaveLength(0);
    expect(JSON.stringify(ev).length).toBeLessThan(TRACE_BUDGET_BYTES);
    expect(ev.tags).toEqual({ spans_dropped: "5000" });
  });
  it("caps 5000 ordinary spans under the budget and the tunnel limit", () => {
    const ev = capTransaction(fake(5000, () => "http.client"));
    expect(ev.spans.length).toBeLessThanOrEqual(MAX_SPANS);
    const size = JSON.stringify(ev).length;
    expect(size).toBeLessThan(TRACE_BUDGET_BYTES);
    expect(size).toBeLessThan(200_000);
  });
  it("halves big spans until under the budget", () => {
    const ev = fake(200, () => "resource.script");
    for (const s of ev.spans) (s.data as Record<string, unknown>).pad = "x".repeat(2000);
    capTransaction(ev);
    expect(JSON.stringify(ev).length).toBeLessThan(TRACE_BUDGET_BYTES);
    expect(ev.spans.length).toBeGreaterThan(0);
  });
  it("leaves a small transaction alone", () => {
    const ev = capTransaction(fake(10, () => "navigation"));
    expect(ev.spans).toHaveLength(10);
    expect((ev as { tags?: unknown }).tags).toBeUndefined();
  });
});

describe("POL5 envelope items", () => {
  const enc = new TextEncoder();
  const head = JSON.stringify({ event_id: "e1", dsn: "https://abc123@o111.ingest.us.sentry.io/222" });
  const bin = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 10, 10, 0, 255]);
  const build = () => {
    const a = enc.encode(`${head}\n{"type":"event"}\n{"message":"m"}\n{"type":"attachment","length":${bin.length},"filename":"call.webm"}\n`);
    const b = enc.encode(`\n{"type":"replay_recording","length":3}\nabc\n{"type":"transaction"}\n{"spans":[]}\n`);
    const out = new Uint8Array(a.length + bin.length + b.length);
    out.set(a); out.set(bin, a.length); out.set(b, a.length + bin.length);
    return out;
  };
  it("allows only plain report types", () => {
    for (const t of ["event", "transaction", "session", "client_report", "span"]) expect(envelopeItemAllowed(t)).toBe(true);
    for (const t of ["attachment", "replay_event", "replay_recording", "profile", "feedback", undefined]) expect(envelopeItemAllowed(t)).toBe(false);
  });
  it("tunnel filter drops attachment and replay items by byte length", () => {
    const r = filterEnvelopeBytes(build())!;
    expect(r).toMatchObject({ kept: 2, dropped: 2 });
    const text = new TextDecoder().decode(r.body);
    expect(text).toBe(`${head}\n{"type":"event"}\n{"message":"m"}\n{"type":"transaction"}\n{"spans":[]}\n`);
  });
  it("tunnel filter refuses a broken envelope", () => {
    expect(filterEnvelopeBytes(enc.encode(`${head}\nnot json\n`))).toBeNull();
    expect(filterEnvelopeBytes(enc.encode(`${head}\n{"type":"attachment","length":999}\nab`))).toBeNull();
  });
  it("browser hook removes attachments in place", () => {
    const env: unknown[] = [{}, [[{ type: "event" }, {}], [{ type: "attachment" }, new Uint8Array(3)], [{ type: "replay_event" }, {}]]];
    filterEnvelope(env);
    expect((env[1] as unknown[]).length).toBe(1);
  });
});

describe("POL5 tunnel forwards only allowed items", () => {
  const DSN = "https://abc123@o111.ingest.us.sentry.io/222";
  let calls: { body: Uint8Array }[] = [];
  const stub = (async (_u: unknown, init?: RequestInit) => { calls.push({ body: new Uint8Array(init!.body as ArrayBuffer | Uint8Array as ArrayBuffer) }); return new Response("{}", { status: 200 }); }) as typeof fetch;
  beforeEach(() => { calls = []; resetMonitoringTunnelLimits(); });
  it("strips an attachment and answers 200 without forwarding an attachment only envelope", async () => {
    const ctx = await makeTestApp({ SENTRY_DSN_WEB: DSN }, { fetch: stub });
    const h = JSON.stringify({ event_id: "e1", dsn: DSN });
    const post = (body: string) => ctx.app.request(MONITORING_TUNNEL_PATH, { method: "POST", body, headers: { "content-type": "text/plain;charset=UTF-8" } });
    let res = await post(`${h}\n{"type":"event"}\n{"message":"x"}\n{"type":"attachment","length":4}\nabcd\n`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(new TextDecoder().decode(calls[0].body)).not.toContain("attachment");
    res = await post(`${h}\n{"type":"attachment","length":4}\nabcd\n`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
