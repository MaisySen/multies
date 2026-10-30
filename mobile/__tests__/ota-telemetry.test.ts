import { memoryKV } from "@/lib/kv";
import { buildEnvelope, buildEvent, createTelemetry, envelopeUrl, framesFromStack, installationId, parseDsn, type UpdateTags } from "@/lib/ota/telemetry";
import { installCrashHandler, resetCrashHandlerForTests } from "@/lib/ota/crash-handler";

const DSN = "https://abc123@o1.ingest.sentry.io/42";
const tags: UpdateTags = { updateId: "upd-1", channel: "production", runtimeVersion: "e184c14", jsVersion: "1.9.6", nativeVersion: "1.9.3", nativeBuild: "17", embedded: false, os: "ios" };

describe("Sentry envelope", () => {
  it("parses the DSN and builds the envelope URL", () => {
    expect(parseDsn(DSN)).toEqual({ key: "abc123", host: "o1.ingest.sentry.io", projectId: "42" });
    expect(envelopeUrl(DSN)).toBe("https://o1.ingest.sentry.io/api/42/envelope/?sentry_key=abc123&sentry_version=7&sentry_client=multies-ota%2F1");
    expect(envelopeUrl("nope")).toBeNull();
  });

  it("tags every event with the update, channel and runtime version", () => {
    const ev = buildEvent({ event: "applied", updateId: "upd-1", message: "Update applied", at: 1_700_000_000_000 }, tags, "inst-1", "e".repeat(32));
    expect(ev.tags).toMatchObject({ app: "mobile", ota_event: "applied", update_id: "upd-1", channel: "production", runtime_version: "e184c14", js_version: "1.9.6", native_build: "17", os: "ios" });
    expect(ev).toMatchObject({ level: "info", environment: "mobile-production", release: "multies-mobile@1.9.6", user: { id: "inst-1" }, fingerprint: ["ota", "applied", "upd-1"], message: { formatted: "Update applied" } });
    const crash = buildEvent({ event: "crash", updateId: "upd-1", message: "boom", error: { type: "TypeError", value: "x is undefined", stack: "TypeError: x\n    at render (index.bundle:10:5)\n    at main (index.bundle:2:1)" }, at: 1 }, tags, "inst-1", "f".repeat(32));
    expect(crash.level).toBe("fatal");
    expect(crash.exception?.values[0].stacktrace.frames.map((f) => f.function)).toEqual(["main", "render"]);
    expect(crash.fingerprint).toEqual(["ota-crash", "upd-1", "TypeError"]);
    const env = buildEnvelope(crash, DSN, 0).split("\n");
    expect(env).toHaveLength(3);
    expect(JSON.parse(env[1])).toEqual({ type: "event" });
    expect(JSON.parse(env[2]).event_id).toBe("f".repeat(32));
  });

  it("reads Hermes and JSC style stacks", () => {
    expect(framesFromStack("foo@http://x/index.bundle:1:2\nbar@http://x/index.bundle:3:4")).toHaveLength(2);
    expect(framesFromStack(undefined)).toEqual([]);
  });
});

describe("telemetry queue", () => {
  it("keeps reports until a DSN is known, then sends them and empties the queue", async () => {
    const store = memoryKV();
    const sent: string[] = [];
    const t = createTelemetry({ store, tags: () => tags, installId: async () => "inst-1", send: async (_u, body) => { sent.push(body); return true; }, now: () => 5000 });
    await t.record({ event: "applied", updateId: "upd-1", message: "Update applied" });
    await t.record({ event: "crash", updateId: "upd-1", message: "boom" });
    expect(sent).toHaveLength(0);
    expect(JSON.parse((await store.get("ota:telemetry:queue"))!)).toHaveLength(2);
    t.setDsn(DSN);
    expect(await t.flush()).toBe(2);
    expect(sent).toHaveLength(2);
    expect(JSON.parse((await store.get("ota:telemetry:queue"))!)).toEqual([]);
  });

  it("keeps what failed to send for the next try, and caps the queue", async () => {
    const store = memoryKV();
    let ok = false;
    const t = createTelemetry({ store, tags: () => tags, installId: async () => "i", send: async () => ok });
    for (let i = 0; i < 30; i++) await t.record({ event: "failed", updateId: "u", message: `m${i}` });
    expect(JSON.parse((await store.get("ota:telemetry:queue"))!)).toHaveLength(25);
    t.setDsn(DSN);
    expect(await t.flush()).toBe(0);
    ok = true;
    expect(await t.flush()).toBe(25);
  });

  it("samples errors but always keeps the applied reports", async () => {
    const store = memoryKV();
    const t = createTelemetry({ store, tags: () => tags, installId: async () => "i", send: async () => true, rand: () => 0.9 });
    t.setDsn(null, 0.1);
    await t.record({ event: "failed", updateId: "u", message: "dropped" });
    await t.record({ event: "applied", updateId: "u", message: "kept" });
    expect(JSON.parse((await store.get("ota:telemetry:queue"))!).map((r: { message: string }) => r.message)).toEqual(["kept"]);
  });

  it("gives each install one stable random id", async () => {
    const store = memoryKV();
    const a = await installationId(store);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await installationId(store)).toBe(a);
  });
});

describe("crash handler", () => {
  beforeEach(() => resetCrashHandlerForTests());

  it("reports a fatal JS error with the running update, then hands it to the original handler", async () => {
    const store = memoryKV();
    const t = createTelemetry({ store, tags: () => tags, installId: async () => "i", send: async () => true });
    const previous = jest.fn();
    let handler: ((e: unknown, fatal?: boolean) => void) | null = null;
    const eu = { getGlobalHandler: () => previous, setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => { handler = h; } };
    expect(installCrashHandler(t, { errorUtils: eu, updateId: () => "upd-1", waitMs: 50 })).toBe(true);
    expect(installCrashHandler(t, { errorUtils: eu, updateId: () => "upd-1" })).toBe(false);
    const err = new TypeError("x is undefined");
    handler!(err, true);
    expect(previous).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    expect(previous).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledWith(err, true);
    const q = JSON.parse((await store.get("ota:telemetry:queue"))!);
    expect(q[0]).toMatchObject({ event: "crash", updateId: "upd-1", error: { type: "TypeError", value: "x is undefined" } });
  });

  it("passes a non fatal error straight on", () => {
    const t = createTelemetry({ store: memoryKV(), tags: () => tags, installId: async () => "i" });
    const previous = jest.fn();
    let handler: ((e: unknown, fatal?: boolean) => void) | null = null;
    installCrashHandler(t, { errorUtils: { getGlobalHandler: () => previous, setGlobalHandler: (h) => { handler = h; } }, updateId: () => null });
    handler!(new Error("soft"), false);
    expect(previous).toHaveBeenCalledTimes(1);
  });
});

describe("Hermes release stacks", () => {
  it("parses 'address at' frames so crash reports keep their stack", () => {
    const stack = "TypeError: Cannot convert 100 to BigInt\n    at anonymous (address at index.bundle:1:123456)\n    at onProgress (address at index.bundle:1:98765)";
    const frames = framesFromStack(stack);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ function: "anonymous", filename: "index.bundle", lineno: 1, colno: 123456 });
    expect(frames[0].function).toBe("onProgress");
  });
});
