#!/usr/bin/env node
/**
 * R44: production first request CPU without waiting for a new isolate.
 *
 * Before R44 the only way to see a new isolate's first request on production was to deploy and hope `wrangler tail`
 * caught one (R43 had no "before" number because none was caught). This script makes the new isolates itself, on the
 * production Worker, without moving any traffic:
 *  1. `wrangler versions upload` makes a new version of the built code (same code, its own version id, no traffic).
 *  2. `wrangler versions deploy <current>@100% <new>@0%` adds it to the deployment at 0%: every real request still goes
 *     to the current version (Cloudflare: version overrides reach "even those set to serve 0% of traffic").
 *  3. A GET with `Cloudflare-Workers-Version-Overrides: mymail="<new>"` runs on the new version. Nobody else can reach
 *     it, so that first GET is a new isolate's first request, every time; N more GETs give its warm numbers.
 *  4. The deployment goes back to `<current>@100%` (in a finally, so also on failure).
 * cpuTime comes from `wrangler tail` (grouped by scriptVersion.id; the `[isolate] first request` log line confirms the
 * first one). Each sample is a fresh upload, so samples never share an isolate. Script startup is not in a request's
 * cpuTime (Cloudflare bills it to startup, with its own larger limit), so this measures what the 10 ms request limit
 * sees. Reads: N+1 small signed GETs per sample. Versions stay in the version list; that is all they cost.
 *
 *   cd <built checkout> && node scripts/creds.mjs run CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID -- \
 *     node scripts/cold-baseline.mjs --samples 3 --warm 5 --label r44 --out /tmp/cold.json
 *
 * Run it with nothing else deploying. The signed GET uses a workspace key read from COLD_KEY_FILE (JSON with workspaceKey; never printed), or, without
 * one, GET /api/config (public). Needs dist/ built (npm run build:worker).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, openSync, closeSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const SAMPLES = Number(opt("samples", "3"));
const WARM = Number(opt("warm", "5"));
const LABEL = opt("label", "cold");
const OUT = opt("out", "/tmp/cold-baseline.json");
const ENV = opt("env", ""); // "" = production script "mymail"; "staging" = mymail-staging
const PATHS = (opt("paths", "/api/v1/projects,/api/v1/tasks?limit=50,/api/v1/views")).split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!process.env.CLOUDFLARE_API_TOKEN) { console.error("run through scripts/creds.mjs run CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID --"); process.exit(2); }
if (!existsSync("dist/worker/_worker.js")) { console.error("build first: dist/worker/_worker.js is missing"); process.exit(2); }

let key = null;
if (process.env.COLD_KEY_FILE) key = JSON.parse(readFileSync(process.env.COLD_KEY_FILE, "utf8")).workspaceKey ?? null;
// R53: or a signed in session (JSON with cookie_name and cookie_value, never printed): the hot app routes the startup
// warm up covers, e.g. --paths "/api/tasks?limit=50,/api/account/me,/api/dashboard".
let cookie = null;
if (!key && process.env.COLD_SESSION_FILE) { const j = JSON.parse(readFileSync(process.env.COLD_SESSION_FILE, "utf8")); cookie = `${j.cookie_name}=${j.cookie_value}`; }
const secret = key ?? cookie;
const headers = key ? { authorization: `Bearer ${key}` } : cookie ? { cookie } : {};
const redact = (s) => (secret ? String(s).split(secret).join("***") : String(s));

const wr = (a, timeoutMs = 300_000) => new Promise((resolve) => {
  const p = spawn("npx", ["wrangler", ...a], { env: { ...process.env, FORCE_COLOR: "0", CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  p.on("close", (code) => { clearTimeout(t); resolve({ code, out: redact(out) }); });
});

// 1. Tail first (a daemon writing to a file; killed by PID at the end).
const tailFile = `${OUT}.tail.jsonl`;
const fd = openSync(tailFile, "w");
const tailArgs = ["wrangler", "tail", ...(ENV ? ["--env", ENV] : ["--env="]), "--format", "json"];
const tail = spawn("npx", tailArgs, { env: { ...process.env, FORCE_COLOR: "0" }, stdio: ["ignore", fd, fd], detached: true });
closeSync(fd);
await sleep(12_000);

const envArgs = ENV ? ["--env", ENV] : ["--env="];
const script = ENV === "staging" ? "mymail-staging" : "mymail";
const st = await wr(["deployments", "status", ...envArgs, "--json"]);
let current = null;
try { const j = JSON.parse(st.out.slice(st.out.indexOf("{"))); const v = j.versions ?? []; if (v.length === 1 && v[0].percentage === 100) current = v[0].version_id; } catch { /* ignore */ }
if (!current) { console.error(`the deployment is not one version at 100%; refusing.\n${st.out.slice(-800)}`); try { process.kill(-tail.pid, "SIGKILL"); } catch { /* ignore */ } process.exit(2); }
console.log(JSON.stringify({ current: current.slice(0, 8), script }));
const samples = [];
try {
  for (let s = 0; s < SAMPLES; s++) {
    const rel = `${LABEL}-cold${s + 1}`;
    const up = await wr(["versions", "upload", ...envArgs, "--var", `RELEASE:${rel}`, "--tag", rel.slice(0, 25), "--message", `R44 cold start sample ${s + 1} (0% traffic)`]);
    writeFileSync(`${OUT}.upload${s + 1}.txt`, up.out);
    const versionId = up.out.match(/Worker Version ID:\s*([0-9a-f-]{36})/i)?.[1];
    if (up.code !== 0 || !versionId) { console.error(`upload ${s + 1} failed:\n${up.out.slice(-1500)}`); break; }
    const dep = await wr(["versions", "deploy", ...envArgs, `${current}@100%`, `${versionId}@0%`, "-y", "--message", `R44 cold sample ${s + 1}: new version at 0%`]);
    if (dep.code !== 0) { console.error(`0% deploy ${s + 1} failed:\n${dep.out.slice(-1500)}`); break; }
    await sleep(5000);
    const base = ENV === "staging" ? "https://mymail-staging.mymail-app.workers.dev" : "https://mymail.mymail-app.workers.dev";
    const calls = [];
    for (let i = 0; i <= WARM; i++) {
      const p = secret ? PATHS[i % PATHS.length] : "/api/config";
      const t0 = Date.now();
      let status = 0;
      try { const r = await fetch(base + p, { headers: { ...headers, "Cloudflare-Workers-Version-Overrides": `${script}="${versionId}"` } }); await r.arrayBuffer(); status = r.status; } catch { status = -1; }
      calls.push({ path: p, status, wallMs: Date.now() - t0 });
      await sleep(300);
    }
    samples.push({ versionId, calls });
    console.log(JSON.stringify({ sample: s + 1, versionId: versionId.slice(0, 8), statuses: calls.map((c) => c.status) }));
  }
  await sleep(15_000); // let the tail catch up
} finally {
  const back = await wr(["versions", "deploy", ...envArgs, `${current}@100%`, "-y", "--message", "R44 cold samples done: back to one version at 100%"]);
  console.log(JSON.stringify({ restored: back.code === 0, current: current.slice(0, 8) }));
  if (back.code !== 0) console.error(`RESTORE FAILED, run: wrangler versions deploy ${current}@100% -y\n${back.out.slice(-800)}`);
  try { process.kill(-tail.pid, "SIGTERM"); } catch { /* ignore */ }
  await sleep(1500);
  try { process.kill(-tail.pid, "SIGKILL"); } catch { /* ignore */ }
}

// 2. Read the tail back. Each line is one JSON event (wrangler prints them pretty; parse by brace depth).
const raw = readFileSync(tailFile, "utf8");
const events = [];
let depth = 0, start = -1, inStr = false, esc = false;
for (let i = 0; i < raw.length; i++) {
  const ch = raw[i];
  if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
  if (ch === '"') { inStr = true; continue; }
  if (ch === "{") { if (depth === 0) start = i; depth++; }
  else if (ch === "}") { depth--; if (depth === 0 && start >= 0) { try { events.push(JSON.parse(raw.slice(start, i + 1))); } catch { /* ignore */ } start = -1; } }
}
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const med = (a) => pct(a, 50);
const result = { at: new Date().toISOString(), label: LABEL, env: ENV || "production", samples: [] };
for (const s of samples) {
  const evs = events.filter((e) => e?.scriptVersion?.id === s.versionId && e?.event?.request).sort((a, b) => a.eventTimestamp - b.eventTimestamp);
  const first = evs[0];
  const firstLog = evs.flatMap((e) => e.logs ?? []).find((l) => JSON.stringify(l.message ?? "").includes("[isolate] first request"));
  result.samples.push({
    versionId: s.versionId, events: evs.length,
    coldCpuMs: first?.cpuTime ?? null, coldWallMs: first?.wallTime ?? null, coldPath: first?.event?.request?.url?.replace(/^https:\/\/[^/]+/, "") ?? null,
    firstRequestLog: firstLog ? JSON.stringify(firstLog.message).slice(0, 300) : null,
    warmCpuMs: evs.slice(1).map((e) => e.cpuTime), statuses: s.calls.map((c) => c.status),
  });
}
const cold = result.samples.map((s) => s.coldCpuMs).filter((v) => typeof v === "number");
const warm = result.samples.flatMap((s) => s.warmCpuMs).filter((v) => typeof v === "number");
result.summary = { coldCpu: { n: cold.length, median: med(cold), max: cold.length ? Math.max(...cold) : null, all: cold },
  warmCpu: { n: warm.length, median: med(warm), p95: pct(warm, 95) },
  tailEvents: events.length };
writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.summary));
