#!/usr/bin/env node
/**
 * R30: Lighthouse on the mobile profile (Lighthouse's default form factor, simulated throttling) against a
 * local production build. Public pages by default; --app also signs a fresh local account up and measures
 * the signed-in inbox, tasks board and docs pages with its session cookie.
 *
 *   npm run build && npm run perf:lh                    # landing and sign in, 3 runs each, median
 *   npm run perf:lh -- --app --runs 3 --out .lighthouse --prefix after
 *
 * Starts its own server on PERF_PORT (8894 unless set) with a throwaway database and stops it at the end.
 * Chrome: CHROME_PATH, else the newest Playwright Chromium in ~/.cache/ms-playwright.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = process.env.PERF_PORT ?? "8894";
const BASE = `http://localhost:${PORT}`;
const RUNS = Number(opt("--runs", "3"));
const OUT = opt("--out", ".lighthouse");
const PREFIX = opt("--prefix", "run");
const ONLY = opt("--pages", "");
const withApp = flag("--app");
const noServer = flag("--no-server");

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = path.join(homedir(), ".cache/ms-playwright");
  const dirs = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const d of dirs) {
    const p = path.join(root, d, "chrome-linux64/chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome found: set CHROME_PATH");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  mkdirSync(".data", { recursive: true });
  const db = ".data/r30perf.db";
  for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  const log = openSync(".data/r30perf-server.log", "w");
  const child = spawn("node", ["dist/server/node.js"], {
    env: { ...process.env, PORT, DATABASE_PATH: db, APP_URL: BASE, OUTBOX_DIR: ".data/r30perf-outbox" },
    stdio: ["ignore", log, log],
    detached: true,
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  process.kill(-child.pid, "SIGKILL");
  throw new Error("server did not start; see .data/r30perf-server.log");
}

/** A fresh local account with a project, a few tasks, a doc and a shared inbox, so the app pages have content. */
async function signIn() {
  const headers = { origin: BASE, "content-type": "application/json" };
  const tag = Math.random().toString(36).slice(2, 8);
  const r = await fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers, body: JSON.stringify({ name: "Petra Perf", email: `petra-${tag}@example.com`, password: "a-strong-password" }) });
  if (!r.ok) throw new Error(`sign up ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const h = { ...headers, cookie };
  const post = async (p, body) => (await fetch(`${BASE}${p}`, { method: "POST", headers: h, body: JSON.stringify(body) })).json().catch(() => ({}));
  const project = (await post("/api/projects", { name: "Website relaunch", key: "WEB" })).project;
  const titles = ["Design the new pricing page", "Write launch announcement", "Accessibility pass on forms", "Set up redirects", "Refresh product screenshots", "Update help centre links"];
  if (project?.id) for (const title of titles) await post("/api/tasks", { title, projectId: project.id, priority: "medium" });
  const doc = (await post("/api/docs", { title: "Launch plan", content: "<h2>Goals</h2><p>Ship the relaunch in two weeks.</p>" }))?.doc;
  return { cookie, projectId: project?.id, docId: doc?.id };
}

function lighthouse(url, file, cookie, attempt = 1) {
  const cmd = ["--no-install", "lighthouse", url, "--output=json", `--output-path=${file}`, "--quiet", "--chrome-flags=--headless=new --no-sandbox", "--only-categories=performance,accessibility,best-practices,seo"];
  if (cookie) cmd.push(`--extra-headers=${JSON.stringify({ Cookie: cookie })}`);
  rmSync(file, { force: true });
  const res = spawnSync("npx", cmd, { env: { ...process.env, CHROME_PATH: chromePath() }, stdio: ["ignore", "ignore", "pipe"], timeout: 300_000, killSignal: "SIGKILL" });
  if (res.status !== 0 || !existsSync(file)) {
    // A busy machine can stall one run; try once more before giving up.
    if (attempt < 2) return lighthouse(url, file, cookie, attempt + 1);
    throw new Error(`lighthouse failed on ${url}: ${String(res.stderr).replace(/.*NO_COLOR.*\n|.*trace-warnings.*\n/g, "").slice(-400)}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

export function summarize(lhr) {
  const a = lhr.audits;
  const items = a["resource-summary"]?.details?.items ?? [];
  const script = items.find((i) => i.resourceType === "script");
  const total = items.find((i) => i.resourceType === "total");
  const score = (k) => Math.round((lhr.categories[k]?.score ?? 0) * 100);
  return {
    perf: score("performance"), a11y: score("accessibility"), bp: score("best-practices"), seo: score("seo"),
    fcp: Math.round(a["first-contentful-paint"].numericValue), lcp: Math.round(a["largest-contentful-paint"].numericValue),
    tbt: Math.round(a["total-blocking-time"].numericValue), cls: Number(a["cumulative-layout-shift"].numericValue.toFixed(3)),
    si: Math.round(a["speed-index"].numericValue),
    jsKB: Math.round((script?.transferSize ?? 0) / 1024), totalKB: Math.round((total?.transferSize ?? 0) / 1024),
    failing: Object.values(lhr.categories).flatMap((c) => c.auditRefs.filter((r) => r.weight > 0 && (a[r.id]?.score ?? 1) < 1 && a[r.id]?.scoreDisplayMode !== "notApplicable").map((r) => `${c.id}:${r.id}`)),
  };
}

const median = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = noServer ? null : await startServer();
  try {
    const pages = [
      { name: "landing", path: "/" },
      { name: "login", path: "/login" },
    ];
    let cookie;
    if (withApp) {
      const s = await signIn();
      cookie = s.cookie;
      pages.push({ name: "inbox", path: "/app/inbox", app: true });
      pages.push({ name: "tasks-board", path: `/app/tasks?view=board${s.projectId ? `&project=${s.projectId}` : ""}`, app: true });
      pages.push({ name: "docs", path: s.docId ? `/app/docs/${s.docId}` : "/app/docs", app: true });
    }
    const results = {};
    for (const p of pages) {
      if (ONLY && !ONLY.split(",").includes(p.name)) continue;
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const lhr = lighthouse(`${BASE}${p.path}`, path.join(OUT, `${PREFIX}-${p.name}-${i + 1}.json`), p.app ? cookie : undefined);
        runs.push(summarize(lhr));
      }
      const keys = ["perf", "a11y", "bp", "seo", "fcp", "lcp", "tbt", "cls", "si", "jsKB", "totalKB"];
      results[p.name] = Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))]));
      results[p.name].failing = [...new Set(runs.flatMap((r) => r.failing))];
      results[p.name].runs = runs.map((r) => r.perf);
      console.log(p.name, JSON.stringify(results[p.name]));
    }
    const load = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
    writeFileSync(path.join(OUT, `${PREFIX}-summary.json`), JSON.stringify({ measuredAt: new Date().toISOString(), loadAverage: load, pages: results }, null, 2));
  } finally {
    if (server) process.kill(-server.pid, "SIGKILL");
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
