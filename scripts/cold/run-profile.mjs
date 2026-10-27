// Cold start profiler (R42, MB-199). Runs the built worker bundle in Node with a fake D1 and times every
// lazily initialised module (esbuild __esm / __commonJS wrappers) per phase: script startup, then one cold
// request, then warm repeats. Usage:
//   node --import ./scripts/cold/register.mjs scripts/cold/run-profile.mjs <timed bundle .mjs> <db> <method path> [cookie file] [--setup]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fakeD1 } from "./fake-d1.mjs";
const [bundle, dbPath, route, cookieFile] = process.argv.slice(2);
const setup = process.argv.includes("--setup");
const DB = fakeD1(dbPath);
globalThis.fetch = async () => new Response("", { status: 204 }); // no network from the profiler
globalThis.__COLD_ENV = {
  DB, ASSETS: { fetch: async () => new Response("asset") },
  APP_MODE: "production", APP_SECRET: "p".repeat(48), APP_URL: "https://app.example.test", DEMO_MODE: "true", DEMO_DAILY_LIMIT: "1000",
  SENTRY_DSN_API: "https://abc123@o1.ingest.sentry.io/1", SENTRY_ENVIRONMENT: "profile", SENTRY_TRACES_SAMPLE_RATE: "0",
  SCHEDULING_ENABLED: "true", FREE_MAIL_DOMAIN: "mail.example.test",
};
const T = (globalThis.__coldT = { stack: [], rec: [], phase: "startup" });
const cpu0 = process.cpuUsage(); const t0 = performance.now();
const mod = await import(bundle);
const startupMs = performance.now() - t0; const startupCpu = process.cpuUsage(cpu0);
const ctx = () => { const p = []; return { c: { waitUntil: (x) => p.push(x), passThroughOnException() {} }, p }; };
let cookieOverride = null;
const cookie0 = cookieFile && existsSync(cookieFile) ? readFileSync(cookieFile, "utf8").trim() : "";
async function hit(label, method, path, body) {
  T.phase = label;
  const { c, p } = ctx();
  const headers = { host: "app.example.test", origin: "https://app.example.test", "user-agent": "cold-profile", accept: "application/json" };
  const cookie = cookieOverride ?? cookie0;
  if (cookie) headers.cookie = cookie;
  if (body) headers["content-type"] = "application/json";
  const req = new Request("https://app.example.test" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const u0 = process.cpuUsage(); const s = performance.now();
  const res = await mod.default.fetch(req, globalThis.__COLD_ENV, c);
  const text = await res.text();
  const ms = performance.now() - s; const cpu = process.cpuUsage(u0);
  await Promise.allSettled(p);
  return { label, status: res.status, ms, cpuMs: (cpu.user + cpu.system) / 1000, bytes: text.length, res, text };
}
for (let i = 0; i < 200 && !mod.lastWarmReport && process.env.NO_WARM_WAIT !== "1"; i++) await new Promise((r) => setTimeout(r, 25));
const out = { warmReport: mod.lastWarmReport ?? null, startupMs, startupCpuMs: (startupCpu.user + startupCpu.system) / 1000, hits: [] };
if (setup) {
  const r = await hit("demo", "POST", "/api/account/demo", {});
  const sc = r.res.headers.getSetCookie ? r.res.headers.getSetCookie() : [r.res.headers.get("set-cookie")];
  writeFileSync(cookieFile, sc.map((x) => x.split(";")[0]).join("; "));
  console.log("demo", r.status, r.text.slice(0, 120), "cookies", sc.length);
  process.exit(0);
}
const [method, path] = route.split(" ");
if (process.argv.includes("--cpuprof")) {
  const { Session } = await import("node:inspector/promises");
  const ses = new Session(); ses.connect();
  if (process.argv.includes("--warmfirst")) for (let i = 0; i < 5; i++) await hit("pre", method, path);
  await ses.post("Profiler.enable"); await ses.post("Profiler.setSamplingInterval", { interval: 50 }); await ses.post("Profiler.start");
  const r = await hit("cold", method, path);
  const { profile } = await ses.post("Profiler.stop");
  writeFileSync(process.argv[process.argv.indexOf("--cpuprof") + 1], JSON.stringify(profile));
  console.log(JSON.stringify({ cold: { status: r.status, ms: r.ms } }));
  process.exit(0);
}
if (process.argv.includes("--prewarm")) {
  const spec = process.argv[process.argv.indexOf("--prewarm") + 1];
  for (const one of spec.split(",")) { const [nc, m2, p2] = one.split(" "); if (nc === "anon") { cookieOverride = ""; } await hit("prewarm", m2, p2); cookieOverride = null; }
}
for (let i = 0; i < 4; i++) { const r = await hit(i === 0 ? "cold" : "warm" + i, method, path); delete r.res; delete r.text; out.hits.push(r); }
const by = {};
for (const r of T.rec) { (by[r.phase] ??= []).push(r); }
const sum = (a, k) => a.reduce((s, x) => s + x[k], 0);
out.inits = Object.fromEntries(Object.entries(by).map(([ph, a]) => [ph, { n: a.length, exclMs: +sum(a, "excl").toFixed(2), top: a.sort((x, y) => y.excl - x.excl).slice(0, 25).map((x) => [x.name, +x.excl.toFixed(2), +x.incl.toFixed(2)]) }]));
console.log(JSON.stringify(out));
process.exit(0);
