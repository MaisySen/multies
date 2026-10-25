#!/usr/bin/env node
/**
 * R25 API speed check (local only). Starts the Node server on a fresh SQLite file, seeds a realistic
 * workspace (3 projects x 2,000 tasks, 50 docs, 5 channels x 2,000 messages, 2,000 mail threads,
 * 10 members), then times the hot reads: N requests each, p50 and p95 in ms.
 *
 *   node scripts/perf-r25.mjs                 (seed and measure, prints a table and writes JSON)
 *   node scripts/perf-r25.mjs --out file.json (where the JSON goes, default .data/perf-r25.json)
 *   node scripts/perf-r25.mjs --keep          (leave the server running for EXPLAIN work)
 *   PERF_N=30 PERF_PORT=8912
 *
 * Never point this at a deployed Multies: it only ever talks to the server it started itself.
 */
import { spawn } from "node:child_process";
import { openSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const PORT = Number(process.env.PERF_PORT ?? 8912);
const N = Number(process.env.PERF_N ?? 30);
const DB = process.env.PERF_DB ?? ".data/perf-r25.db";
const args = process.argv.slice(2);
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : ".data/perf-r25.json";
const KEEP = args.includes("--keep");
const BASE = `http://localhost:${PORT}`;
const ORIGIN = { origin: BASE };

mkdirSync(".data", { recursive: true });
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
const log = openSync(".data/perf-r25-server.log", "w");
const server = spawn("npx", ["tsx", "src/entry/node.ts"], {
  env: { ...process.env, PORT: String(PORT), DATABASE_PATH: DB, OUTBOX_DIR: ".data/perf-r25-outbox", TRUST_PROXY: "true", APP_URL: BASE, NODE_ENV: "development", PERF_COUNT_PORT: String(PORT + 100), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ./scripts/perf-r25-count.cjs` },
  stdio: ["ignore", log, log], detached: true,
});
const stop = () => { try { process.kill(-server.pid, "SIGKILL"); } catch { /* gone */ } };
process.on("exit", () => { if (!KEEP) stop(); });

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start, see .data/perf-r25-server.log");
}

let ipN = 0;
function client() {
  const ip = `10.25.${Math.floor(++ipN / 200)}.${ipN % 200 + 1}`;
  let cookie = "";
  const call = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method, headers: { ...ORIGIN, "x-forwarded-for": ip, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) {
      const jar = new Map(cookie ? cookie.split("; ").map((p) => [p.split("=")[0], p]) : []);
      for (const s of set) { const kv = s.split(";")[0]; jar.set(kv.split("=")[0], kv); }
      cookie = [...jar.values()].join("; ");
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (res.status >= 400 && !call.quiet) throw new Error(`${method} ${path} ${res.status} ${text.slice(0, 300)}`);
    return { status: res.status, json, headers: res.headers };
  };
  return call;
}

const id = (p, n) => `${p}${String(n).padStart(6, "0")}`;
const WORDS = ["pricing", "launch", "onboarding", "invoice", "roadmap", "billing", "design", "mobile", "search", "report", "security", "export", "calendar", "customer", "release"];
const word = (n) => WORDS[n % WORDS.length];

async function seed() {
  const owner = client();
  await owner("POST", "/api/auth/sign-up/email", { name: "Olivia Owner", email: "olivia@perf.test", password: "a-strong-password" });
  await owner("PATCH", "/api/account/preferences", { timezone: "UTC", locale: "en" });
  const me = (await owner("GET", "/api/account/me")).json;
  const memberIds = [me.user.id];
  for (let i = 1; i < 10; i++) {
    const m = client();
    await m("POST", "/api/auth/sign-up/email", { name: `Member ${i}`, email: `member${i}@perf.test`, password: "a-strong-password" });
    memberIds.push((await m("GET", "/api/account/me")).json.user.id);
  }
  const projects = [];
  for (const [name, key] of [["Website", "WEB"], ["Mobile app", "APP"], ["Operations", "OPS"]]) {
    projects.push((await owner("POST", "/api/projects", { name, key })).json.project);
  }
  const sprints = [];
  for (const p of projects) {
    await owner("POST", "/api/tasks", { title: `First task in ${p.name}`, projectId: p.id });
    sprints.push((await owner("POST", "/api/sprints", { projectId: p.id, name: "Sprint 1" })).json);
  }
  await owner("POST", "/api/docs", { title: "Handbook", text: "# Handbook\nHow we work." });
  const channels = [];
  for (const name of ["general", "product", "engineering", "support", "random"]) {
    const ch = (await owner("POST", "/api/chat/channels", { name })).json.channel;
    channels.push(ch);
    await owner("POST", `/api/chat/channels/${ch.id}/messages`, { body: `Welcome to ${name}` });
  }
  await owner("POST", "/api/dashboards", { name: "Team", starter: "team" });
  const dash = (await owner("GET", "/api/dashboards")).json.dashboards[0];

  // Bulk rows straight into SQLite, cloned from the rows the API just wrote so every column is real.
  const db = new Database(DB);
  db.pragma("busy_timeout = 10000");
  const org = db.prepare("SELECT org_id FROM projects WHERE id = ?").get(projects[0].id).org_id;
  const now = Date.now();
  const DAY = 86_400_000;
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const clone = (table, templateId, rows) => {
    const names = cols(table);
    const tpl = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(templateId);
    const ins = db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map((n) => "@" + n).join(",")})`);
    db.transaction(() => { for (const r of rows) ins.run({ ...tpl, ...r }); })();
  };
  // Members of the owner's org.
  const memTpl = db.prepare("SELECT * FROM members WHERE user_id = ? AND organization_id = ?").get(me.user.id, org);
  const memCols = cols("members");
  const memIns = db.prepare(`INSERT INTO members (${memCols.join(",")}) VALUES (${memCols.map((n) => "@" + n).join(",")})`);
  for (let i = 1; i < memberIds.length; i++) memIns.run({ ...memTpl, id: id("mem", i), user_id: memberIds[i], role: "member" });

  for (const [pi, p] of projects.entries()) {
    const statuses = db.prepare("SELECT id, category FROM project_statuses WHERE project_id = ? ORDER BY position").all(p.id);
    const tpl = db.prepare("SELECT id FROM tasks WHERE project_id = ?").get(p.id).id;
    const sprintId = db.prepare("SELECT id FROM sprints WHERE project_id = ?").get(p.id)?.id ?? null;
    const rows = [];
    for (let n = 2; n <= 2000; n++) {
      const st = statuses[n % statuses.length];
      const status = st.category === "done" ? "done" : st.category === "started" || st.category === "doing" ? "doing" : "todo";
      rows.push({
        id: id(`t${pi}`, n), number: n, title: `${word(n)} ${word(n * 7)} item ${n}`, notes: `Notes about ${word(n * 3)}`,
        status_id: st.id, status, assignee_type: n % 6 === 0 ? null : "member", assignee_id: n % 6 === 0 ? null : memberIds[n % memberIds.length],
        priority: ["none", "low", "medium", "high", "urgent"][n % 5], due_at: n % 3 === 0 ? null : now + ((n % 60) - 20) * DAY,
        position: n, sprint_id: n % 10 === 0 ? sprintId : null, points: n % 4 === 0 ? null : (n % 8) + 1,
        completed_at: status === "done" ? now - (n % 30) * DAY : null, parent_id: n % 25 === 0 ? id(`t${pi}`, n - 1) : null,
        created_at: now - (n % 90) * DAY, updated_at: now - (n % 40) * DAY,
      });
    }
    clone("tasks", tpl, rows);
  }
  const docTpl = db.prepare("SELECT id FROM docs WHERE org_id = ?").get(org).id;
  clone("docs", docTpl, Array.from({ length: 49 }, (_, i) => ({ id: id("doc", i), title: `${word(i)} guide ${i}`, created_at: now - i * DAY, updated_at: now - i * DAY })));
  for (const [ci, ch] of channels.entries()) {
    const tpl = db.prepare("SELECT id FROM chat_messages WHERE channel_id = ?").get(ch.id).id;
    clone("chat_messages", tpl, Array.from({ length: 1999 }, (_, i) => ({
      id: id(`c${ci}`, i), body: `Message ${i} about ${word(i)} and ${word(i * 5)}`, author_id: memberIds[i % memberIds.length], author_name: `Member ${i % 10}`,
      parent_id: i % 20 === 19 ? id(`c${ci}`, i - 1) : null, created_at: now - (2000 - i) * 60_000, updated_at: now - (2000 - i) * 60_000,
    })));
  }
  // A domain and a mailbox, then 2,000 threads (3,000 messages).
  db.prepare("INSERT INTO domains (id, org_id, name, status, verification_token, dkim_selector, dkim_public_key, dkim_private_key_enc, created_at) VALUES ('dom1', ?, 'perf.test', 'verified', 'x', 'mm', 'x', 'x', ?)").run(org, now);
  db.prepare("INSERT INTO mailboxes (id, org_id, domain_id, local_part, address, display_name, quota_mb, created_at) VALUES ('mbx1', ?, 'dom1', 'olivia', 'olivia@perf.test', 'Olivia', 5000, ?)").run(org, now);
  const mIns = db.prepare("INSERT INTO messages (id, org_id, mailbox_id, folder, message_id_header, thread_id, from_address, from_name, to_json, subject, text_body, snippet, size_bytes, is_read, date, created_at) VALUES (?, ?, 'mbx1', ?, ?, ?, ?, ?, '[\"olivia@perf.test\"]', ?, ?, ?, 900, ?, ?, ?)");
  db.transaction(() => {
    let k = 0;
    for (let t = 0; t < 2000; t++) {
      const parts = t % 2 === 0 ? 2 : 1;
      for (let j = 0; j < parts; j++) {
        const at = now - (2000 - t) * 3_600_000 + j * 600_000;
        mIns.run(id("msg", k++), org, t % 10 === 9 ? "archive" : "inbox", `<m${k}@perf.test>`, id("thr", t), `sender${t % 50}@example.com`, `Sender ${t % 50}`,
          `${word(t)} question ${t}`, `Hello, about the ${word(t)} for ${word(t * 3)}.`, `Hello, about the ${word(t)}`, t % 3 === 0 ? 0 : 1, at, at);
      }
    }
  })();
  const nIns = db.prepare("INSERT INTO notifications (id, org_id, user_id, type, entity_type, entity_id, title, actor_name, read_at, created_at) VALUES (?, ?, ?, 'task.assigned', 'task', ?, ?, 'Member 1', ?, ?)");
  db.transaction(() => { for (let i = 0; i < 500; i++) nIns.run(id("ntf", i), org, me.user.id, id("t0", (i % 1998) + 2), `Assigned: item ${i}`, i % 2 ? now - i * 1000 : null, now - i * 60_000); })();
  db.close();
  return { owner, projects, channels, sprints, dash, orgId: org };
}

function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]; }

async function main() {
  await waitUp();
  const t0 = Date.now();
  const s = await seed();
  console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  // The server runs its first housekeeping pass 5 s after start: let it finish so it is not timed.
  await new Promise((r) => setTimeout(r, Math.max(0, 7_000 - (Date.now() - t0))));
  const p = s.projects[0].id;
  const sprintId = s.sprints[0]?.sprint?.id ?? s.sprints[0]?.id;
  const endpoints = [
    ["account me", "/api/account/me"],
    ["config", "/api/config"],
    ["my work", "/api/my-work?tz=UTC"],
    ["tasks list", `/api/tasks?projectId=${p}`],
    ["tasks board", `/api/tasks?projectId=${p}&view=board`],
    ["sprints", `/api/sprints?projectId=${p}`],
    ["sprint detail", sprintId ? `/api/sprints/${sprintId}` : null],
    ["sprint backlog", `/api/sprints/backlog?projectId=${p}`],
    ["projects", "/api/projects"],
    ["assignees", "/api/tasks/assignees"],
    ["team people", "/api/team/people"],
    ["dashboard overview", "/api/dashboard"],
    ["dashboard widgets", `/api/dashboards/${s.dash.id}/data?tz=UTC`],
    ["search", "/api/search?q=pricing"],
    ["chat channels", "/api/chat/channels"],
    ["chat messages", `/api/chat/channels/${s.channels[0].id}/messages`],
    ["inbox threads", "/api/mail/messages?folder=inbox"],
    ["notifications", "/api/notifications"],
    ["workload", `/api/workload?projectId=${p}`],
  ].filter(([, u]) => u);
  const results = [];
  const sqlByEndpoint = {};
  for (const [name, url] of endpoints) {
    await s.owner("GET", url); // warm
    await fetch(`http://127.0.0.1:${PORT + 100}/reset`);
    const first = await s.owner("GET", url);
    const sql = await (await fetch(`http://127.0.0.1:${PORT + 100}/dump`)).json();
    sqlByEndpoint[name] = sql;
    const bytes = JSON.stringify(first.json).length;
    const times = [];
    for (let i = 0; i < N; i++) {
      const a = performance.now();
      await s.owner("GET", url);
      times.push(performance.now() - a);
    }
    times.sort((x, y) => x - y);
    results.push({ name, url: url.replace(/[A-Za-z0-9_-]{16,}/g, ":id"), status: first.status, bytes, queries: sql.length, sqlMs: +sql.reduce((a, q) => a + q.ms, 0).toFixed(1), p50: +pct(times, 50).toFixed(1), p95: +pct(times, 95).toFixed(1) });
  }
  console.table(results.map(({ name, status, bytes, queries, sqlMs, p50, p95 }) => ({ name, status, bytes, queries, sqlMs, p50, p95 })));
  writeFileSync(OUT, JSON.stringify({ n: N, at: new Date().toISOString(), results }, null, 2));
  writeFileSync(OUT.replace(/\.json$/, "") + ".sql.json", JSON.stringify(sqlByEndpoint, null, 2));
  if (KEEP) { console.log(`server left running on ${BASE} (pid group ${server.pid}), db ${DB}`); process.exit(0); }
  stop();
  process.exit(0);
}
main().catch((e) => { console.error(e); stop(); process.exit(1); });
