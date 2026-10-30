#!/usr/bin/env node
/* global __dirname */
/**
 * Publish an over the air update (EAS Update) after the guard in scripts/ota-guard.js says it is safe.
 *
 *   npm run ota:preview -- --message "Fix the task list spacing"
 *   npm run ota:production -- --rollout 10 [--critical] [--message "..."]   staged release to 10% of phones
 *   npm run ota:health [-- --auto-rollback]     crash and failure rates of the newest production update (Sentry)
 *   npm run ota:promote -- 50                   grow the rollout (refused unless health says healthy)
 *   npm run ota:rollback [-- --embedded]        undo the newest production update on every platform
 *   npm run ota:status                          what each platform runs on production now
 *   node scripts/ota.js preview --check         run the guard only (npm run ota:check)
 *
 * See docs/OTA.md. Run through the credentials helper so EXPO_TOKEN (EAS), SENTRY_OPS_TOKEN, SENTRY_ORG,
 * SENTRY_DSN_WEB (health) and APP_CONFIG_TOKEN (critical and rolled back update ids) are in the env:
 *   node ../app/scripts/creds.mjs run EXPO_TOKEN,SENTRY_OPS_TOKEN,SENTRY_ORG,SENTRY_DSN_WEB,APP_CONFIG_TOKEN -- npm run ota:health
 */
const { execFileSync } = require("child_process");
const { join } = require("path");
const { latestGroupsByPlatform, parseFlags, rolloutOf } = require("./ota-guard");
const { evaluateHealth, fetchHealthRows, ageHoursFrom } = require("./ota-health");

const root = join(__dirname, "..");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

function easJson(args) {
  const out = run("eas", [...args, "--json"]);
  return JSON.parse(out.slice(out.search(/[[{]/)));
}

const API = process.env.APP_CONFIG_API || "https://multies.si";

/** Newest update group per platform on a branch, with its update ids and rollout. */
function currentGroups(branch) {
  const list = easJson(["update:list", "--branch", branch, "--limit", "20", "--non-interactive"]);
  const latest = latestGroupsByPlatform(list);
  return latest.map((g) => {
    const view = easJson(["update:view", g.group]);
    const rows = Array.isArray(view) ? view : [];
    return { ...g, updateIds: rows.map((u) => u.id).filter(Boolean), rollout: g.rollout ?? rolloutOf(rows), commit: (rows[0] || {}).gitCommitHash || null, ageHours: ageHoursFrom(rows) };
  });
}

/** Change the remote app config (critical or rolled back update ids). Prints, never throws. */
async function patchAppConfig(patch, why) {
  const token = process.env.APP_CONFIG_TOKEN;
  if (!token) {
    console.log(`APP_CONFIG_TOKEN is not set, so ${why} was not recorded in the app config. Run with the credentials helper, or by hand:`);
    console.log(`  curl -X PUT ${API}/api/v1/app-config -H "authorization: Bearer $APP_CONFIG_TOKEN" -H "content-type: application/json" -d '${JSON.stringify(patch)}'`);
    return false;
  }
  try {
    const res = await fetch(`${API}/api/v1/app-config`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(patch) });
    console.log(res.ok ? `App config updated: ${why}.` : `App config refused the change (${res.status}): ${why} not recorded.`);
    return res.ok;
  } catch (e) {
    console.log(`Could not reach the app config (${e.message}): ${why} not recorded.`);
    return false;
  }
}

async function health(flags) {
  const groups = flags.group ? (() => { const v = easJson(["update:view", flags.group]); return [{ group: flags.group, platform: "?", updateIds: v.map((u) => u.id), ageHours: ageHoursFrom(v) }]; })() : currentGroups("production");
  const ids = groups.flatMap((g) => g.updateIds);
  const rows = await fetchHealthRows(ids, process.env, globalThis.fetch, flags.period || "14d");
  const th = {};
  if (flags["max-crash-rate"]) th.maxCrashRate = Number(flags["max-crash-rate"]);
  if (flags["min-installs"]) th.minInstalls = Number(flags["min-installs"]);
  if (flags["min-age-hours"]) th.minAgeHours = Number(flags["min-age-hours"]);
  const ages = groups.map((g) => g.ageHours).filter((a) => a != null);
  const h = evaluateHealth(rows, th, { ageHours: ages.length ? Math.min(...ages) : null });
  for (const g of groups) console.log(`${g.platform}: group ${g.group}${g.rollout != null ? `, rollout ${g.rollout}%` : ""}`);
  console.log(`Health: ${h.verdict.toUpperCase()} (${h.reasons.join("; ")})`);
  return { h, groups };
}

async function rollback(flags, groups) {
  groups = groups || currentGroups("production");
  const bad = [];
  for (const g of groups) {
    if (flags.embedded) {
      console.log(`${g.platform}: back to the store build's own bundle (runtime ${g.runtimeVersion.slice(0, 10)})`);
      execFileSync("eas", ["update:roll-back-to-embedded", "--channel", "production", "--runtime-version", g.runtimeVersion, "--platform", g.platform, "--force-end-active-rollout", "--message", flags.message || "Roll back to the store build", "--non-interactive"], { cwd: root, stdio: "inherit" });
    } else if (g.rollout != null && g.rollout < 100) {
      console.log(`${g.platform}: ending the ${g.rollout}% rollout of ${g.group}; every phone goes back to the update before it`);
      execFileSync("eas", ["update:revert-update-rollout", "--group", g.group, "--message", flags.message || "Revert rollout", "--non-interactive"], { cwd: root, stdio: "inherit" });
    } else {
      console.log(`${g.platform}: republishing the update before ${g.group}`);
      execFileSync("eas", ["update:rollback", g.group, "--message", flags.message || "Roll back", "--non-interactive"], { cwd: root, stdio: "inherit" });
    }
    bad.push(...g.updateIds);
  }
  // Phones still running the bad update take the replacement at once instead of at their next cold start.
  if (bad.length) await patchAppConfig({ ota: { add_blocked_update_ids: bad.slice(0, 10), remove_critical_update_ids: bad.slice(0, 50) } }, `rolled back ${bad.length} update id(s)`);
}

/** Publishing lives in scripts/ota-publish.js: it reads the live store builds from App Store Connect,
 * EAS and Play, refuses unless the runtime matches, publishes, then checks the update server. */
function publish(channel, rest) {
  execFileSync("node", [join(__dirname, "ota-publish.js"), channel, ...rest], { cwd: root, stdio: "inherit" });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (cmd === "preview" || cmd === "production") return publish(cmd, rest);
  if (cmd === "status") {
    for (const g of currentGroups("production")) console.log(`${g.platform}: group ${g.group}, updates ${g.updateIds.join(", ")}, ${g.rollout != null ? `rollout ${g.rollout}%` : "all phones"}${g.isRollBackToEmbedded ? " (roll back to the store bundle)" : ""}, commit ${(g.commit || "?").slice(0, 7)}, "${g.message}"`);
    return;
  }
  if (cmd === "health") {
    const { h, groups } = await health(flags);
    if (h.verdict === "rollback" && flags["auto-rollback"]) { console.log("Rolling back automatically (--auto-rollback)."); await rollback(flags, groups); }
    process.exit({ healthy: 0, wait: 10, halt: 20, rollback: 30 }[h.verdict]);
  }
  if (cmd === "promote") {
    const pct = Number(flags._[0]);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw new Error("Usage: npm run ota:promote -- <percent 1 to 100>");
    const { h, groups } = await health(flags);
    if (h.verdict === "rollback") { console.error("Not promoting: this update should be rolled back (npm run ota:rollback)."); process.exit(30); }
    if (h.verdict === "halt" || (h.verdict === "wait" && !flags.force)) { console.error(`Not promoting: health says ${h.verdict}. Wait for more phones, or pass --force after checking Sentry yourself.`); process.exit(20); }
    for (const g of groups) {
      if (g.rollout == null) { console.log(`${g.platform}: group ${g.group} already reaches every phone.`); continue; }
      execFileSync("eas", ["update:edit", g.group, "--rollout-percentage", String(pct), "--non-interactive"], { cwd: root, stdio: "inherit" });
      console.log(`${g.platform}: rollout ${g.rollout}% -> ${pct}%`);
    }
    return;
  }
  if (cmd === "rollback") return rollback(flags);
  throw new Error("Usage: node scripts/ota.js preview|production|status|health|promote|rollback (see docs/OTA.md)");
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { patchAppConfig };
