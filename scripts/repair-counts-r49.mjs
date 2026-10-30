#!/usr/bin/env node
// R49: recount the task row counts (0087) and the per project status summary (0088) for ONE workspace.
// Dry run by default: prints how many task rows and summary buckets are off, and the SQL it would run.
// --apply runs the repair. Target: --local (wrangler local D1), --env staging, or --env production.
// Usage: node scripts/repair-counts-r49.mjs <org_id> [--local | --env staging|production] [--apply]
// The Cloudflare token comes from the environment only (run it through scripts/creds.mjs run ... --).
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
const org = args.find((a) => !a.startsWith("--") && !["staging", "production"].includes(a));
if (!org || !/^[A-Za-z0-9_-]+$/.test(org)) { console.error("usage: repair-counts-r49.mjs <org_id> [--local | --env staging|production] [--apply]"); process.exit(2); }
const apply = args.includes("--apply");
const envIdx = args.indexOf("--env");
const target = args.includes("--local") ? ["--local"] : envIdx >= 0 ? ["--remote", "--env", args[envIdx + 1]] : ["--local"];
if (envIdx >= 0 && args[envIdx + 1] === "production") target.splice(1, 2, "--env=");
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const O = q(org);
const live = `deleted_at IS NULL AND triage_state IS NULL`;
export const CHECK = [
  `SELECT 'task_rows_off' AS what, count(*) AS n FROM tasks t WHERE t.org_id = ${O} AND (
     t.comment_count <> (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL)
  OR t.checklist_total <> (SELECT count(*) FROM task_checklist_items i WHERE i.task_id = t.id)
  OR t.checklist_done <> (SELECT count(*) FROM task_checklist_items i WHERE i.task_id = t.id AND i.done = 1)
  OR t.subtask_total <> (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL)
  OR t.subtask_done <> (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.status = 'done')
  OR t.field_count <> (SELECT count(*) FROM task_field_values f WHERE f.task_id = t.id))`,
  `SELECT 'buckets_off' AS what, count(*) AS n FROM (
     SELECT project_id, status, count(*) AS n FROM tasks WHERE org_id = ${O} AND ${live} GROUP BY project_id, status
     EXCEPT SELECT project_id, status, n FROM project_status_counts WHERE org_id = ${O} AND n > 0)`,
  // R50: the other direction too, a stored bucket that no longer matches any live task.
  `SELECT 'buckets_extra' AS what, count(*) AS n FROM (
     SELECT project_id, status, n FROM project_status_counts WHERE org_id = ${O} AND n > 0
     EXCEPT SELECT project_id, status, count(*) FROM tasks WHERE org_id = ${O} AND ${live} GROUP BY project_id, status)`,
];
export const REPAIR = [
  `UPDATE tasks SET
     comment_count = (SELECT count(*) FROM task_comments c WHERE c.task_id = tasks.id AND c.deleted_at IS NULL),
     checklist_total = (SELECT count(*) FROM task_checklist_items i WHERE i.task_id = tasks.id),
     checklist_done = (SELECT count(*) FROM task_checklist_items i WHERE i.task_id = tasks.id AND i.done = 1),
     subtask_total = (SELECT count(*) FROM tasks s WHERE s.parent_id = tasks.id AND s.deleted_at IS NULL),
     subtask_done = (SELECT count(*) FROM tasks s WHERE s.parent_id = tasks.id AND s.deleted_at IS NULL AND s.status = 'done'),
     field_count = (SELECT count(*) FROM task_field_values f WHERE f.task_id = tasks.id)
   WHERE org_id = ${O} AND id IN (SELECT t.id FROM tasks t WHERE t.org_id = ${O} AND (
     t.comment_count <> (SELECT count(*) FROM task_comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL)
  OR t.checklist_total <> (SELECT count(*) FROM task_checklist_items i WHERE i.task_id = t.id)
  OR t.checklist_done <> (SELECT count(*) FROM task_checklist_items i WHERE i.task_id = t.id AND i.done = 1)
  OR t.subtask_total <> (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL)
  OR t.subtask_done <> (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.status = 'done')
  OR t.field_count <> (SELECT count(*) FROM task_field_values f WHERE f.task_id = t.id)))`,
  `DELETE FROM project_status_counts WHERE org_id = ${O}`,
  `INSERT INTO project_status_counts (org_id, project_id, status, n) SELECT org_id, project_id, status, count(*) FROM tasks WHERE org_id = ${O} AND ${live} GROUP BY org_id, project_id, status`,
];
function run(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", ...target, "--json", "--command", sql.replace(/\s+/g, " ")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 24 });
  return JSON.parse(out.slice(out.indexOf("[")));
}
const report = (label) => {
  const r = CHECK.map((s) => run(s)[0]);
  const rows = r.map((x) => ({ what: x.results?.[0]?.what, n: x.results?.[0]?.n, rows_read: x.meta?.rows_read }));
  console.log(label, JSON.stringify(rows));
  return rows;
};
const before = report("before");
if (!apply) {
  console.log("dry run: nothing changed. Would run:\n" + REPAIR.map((s) => s.replace(/\s+/g, " ")).join(";\n") + ";\nRun again with --apply to repair.");
  process.exit(0);
}
if (before.every((x) => x.n === 0)) { console.log("nothing to repair"); process.exit(0); }
for (const s of REPAIR) { const r = run(s)[0]; console.log("ran", JSON.stringify({ rows_read: r.meta?.rows_read, rows_written: r.meta?.rows_written })); }
report("after");
