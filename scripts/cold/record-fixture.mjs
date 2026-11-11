// Records the warm up fixture (R42, MB-199): the database answers a demo workspace gives for the hot signed in GETs.
// Usage (from app/): node --import ./scripts/cold/register.mjs scripts/cold/record-fixture.mjs <plain bundle .mjs> [out json]
// The bundle must be built from the same source (scripts/cold/build-profile.mjs). Writes src/entry/warm-fixture.json.
import { writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fakeD1, recordingD1 } from "./fake-d1.mjs";
const [bundle, outFile = "src/entry/warm-fixture.json"] = process.argv.slice(2);
const dbPath = "/tmp/warm-fixture.sqlite";
execFileSync(process.execPath, [new URL("./setup-db.mjs", import.meta.url).pathname, "drizzle", dbPath], { stdio: "inherit" });
const DB = recordingD1(fakeD1(dbPath));
globalThis.fetch = async () => new Response("", { status: 204 });
const ORIGIN = "https://multies.si";
// Semgrep (QUAL1): the warm up copy's signing value, the same not-a-secret as src/entry/warmup.ts.
const WARM_SECRET = "warm-up-only-copy-signing-value-not-a-secret-0001"; // src/entry/warmup.ts // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
globalThis.__COLD_ENV = { DB, ASSETS: { fetch: async () => new Response("asset") }, APP_MODE: "production", APP_SECRET: WARM_SECRET, APP_URL: ORIGIN, DEMO_MODE: "true", DEMO_DAILY_LIMIT: "1000", STARTUP_WARM: "off", SCHEDULING_ENABLED: "true", FREE_MAIL_DOMAIN: "mail.multies.si" };
const mod = await import(bundle);
const ROUTES = ["/api/account/me", "/api/org", "/api/team", "/api/dashboard", "/api/counts", "/api/my-work", "/api/projects", "/api/tasks?limit=50", "/api/notifications", "/api/mailboxes"];
const base = { host: "multies.si", origin: ORIGIN, accept: "application/json", "user-agent": "warmup" };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const demo = await mod.default.fetch(new Request(ORIGIN + "/api/account/demo", { method: "POST", headers: { ...base, "content-type": "application/json" }, body: "{}" }), globalThis.__COLD_ENV, ctx);
const cookie = demo.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
if (demo.status !== 201 || !cookie.includes("session_token")) throw new Error("demo sign in failed: " + demo.status);
await new Promise((r) => setTimeout(r, 300));
DB.calls.length = 0;
const statuses = [];
for (const p of ROUTES) {
  const res = await mod.default.fetch(new Request(ORIGIN + p, { headers: { ...base, cookie } }), globalThis.__COLD_ENV, ctx);
  await res.text(); statuses.push(res.status);
}
// Keep the fixture small: long result lists are cut to 25 rows (enough for every code path to run).
const trim = (v) => Array.isArray(v) ? v.slice(0, 25) : v && typeof v === "object" && Array.isArray(v.results) ? { ...v, results: v.results.slice(0, 25) } : v;
const calls = DB.calls.map((c) => ({ sql: c.sql, method: c.method, ret: trim(c.ret) }));
writeFileSync(outFile, JSON.stringify({ cookie, routes: ROUTES, calls }) + "\n");
rmSync(dbPath, { force: true }); rmSync(dbPath + "-wal", { force: true }); rmSync(dbPath + "-shm", { force: true });
console.log("fixture", outFile, "routes", statuses.join(","), "calls", calls.length, "bytes", JSON.stringify({ cookie, routes: ROUTES, calls }).length);
process.exit(0);
