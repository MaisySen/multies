#!/usr/bin/env node
/**
 * Update health from Sentry (docs/OTA.md, "Health gating"). Phones report `applied`, `crash`,
 * `launch_crash`, `failed` and `download_failed` with the update id as a tag (src/lib/ota/telemetry.ts).
 * This reads the counts of distinct installs per event for one or more update ids and decides
 * whether a staged rollout may grow, must hold, or must be rolled back.
 *
 * Pure parts are exported for __tests__/ota-health.test.ts; the Sentry call needs SENTRY_OPS_TOKEN,
 * SENTRY_ORG and the project (SENTRY_PROJECT_ID, or the DSN in SENTRY_DSN_MOBILE / SENTRY_DSN_WEB).
 */

const DEFAULT_THRESHOLDS = {
  /** Crashed installs / installs that applied the update, in percent. */
  maxCrashRate: 2,
  /** Installs whose update failed to load or download, in percent. */
  maxFailRate: 5,
  /** Below this many installs the rates are noise: never promote on less, only roll back on clear signals. */
  minInstalls: 20,
  /** Absolute crash count that rolls back even on a small sample. */
  maxCrashedInstalls: 5,
};

/**
 * rows: [{ event, users, count }] for the update ids. Returns { verdict, installs, crashed, failed,
 * crashRate, failRate, reasons }. verdict: "healthy" (may promote), "wait" (too little data),
 * "halt" (stop, do not promote) or "rollback".
 */
function evaluateHealth(rows, t = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...t };
  const by = (names) => rows.filter((r) => names.includes(r.event)).reduce((n, r) => n + (Number(r.users) || 0), 0);
  const installs = by(["applied"]);
  const crashed = by(["crash", "launch_crash"]);
  const failed = by(["failed", "download_failed"]);
  const crashRate = installs ? (100 * crashed) / installs : 0;
  const failRate = installs ? (100 * failed) / (installs + failed) : 0;
  const reasons = [];
  let verdict = "healthy";
  if (crashed >= th.maxCrashedInstalls && (!installs || crashRate > th.maxCrashRate)) {
    verdict = "rollback";
    reasons.push(`${crashed} installs crashed${installs ? ` (${crashRate.toFixed(1)}% of ${installs})` : ""}`);
  } else if (installs >= th.minInstalls && crashRate > th.maxCrashRate) {
    verdict = "rollback";
    reasons.push(`crash rate ${crashRate.toFixed(1)}% is above ${th.maxCrashRate}% (${crashed} of ${installs} installs)`);
  } else if (installs >= th.minInstalls && failRate > th.maxFailRate) {
    verdict = "halt";
    reasons.push(`update failed on ${failRate.toFixed(1)}% of phones (${failed}), above ${th.maxFailRate}%`);
  } else if (crashed > 0 && installs < th.minInstalls) {
    verdict = "halt";
    reasons.push(`${crashed} crash${crashed === 1 ? "" : "es"} on only ${installs} installs: hold until there is more data`);
  } else if (installs < th.minInstalls) {
    verdict = "wait";
    reasons.push(`only ${installs} of the ${th.minInstalls} installs needed to judge`);
  } else {
    reasons.push(`${installs} installs, crash rate ${crashRate.toFixed(1)}%, failures ${failRate.toFixed(1)}%`);
  }
  return { verdict, installs, crashed, failed, crashRate, failRate, reasons };
}

/** Sentry Discover rows ({ ota_event, "count_unique(user)", "count()" }) to [{ event, users, count }]. */
function rowsFromDiscover(json) {
  const data = (json && json.data) || [];
  const out = {};
  for (const r of data) {
    const e = r.ota_event || r["tags[ota_event]"];
    if (!e) continue;
    out[e] = out[e] || { event: e, users: 0, count: 0 };
    out[e].users += Number(r["count_unique(user)"]) || 0;
    out[e].count += Number(r["count()"]) || 0;
  }
  return Object.values(out);
}

function projectIdFromEnv(env) {
  if (env.SENTRY_PROJECT_ID) return env.SENTRY_PROJECT_ID;
  const dsn = env.SENTRY_DSN_MOBILE || env.SENTRY_DSN_WEB || "";
  const m = dsn.match(/\/(\d+)$/);
  return m ? m[1] : null;
}

function discoverQuery(updateIds) {
  const ids = updateIds.filter(Boolean);
  if (!ids.length) throw new Error("No update ids to check.");
  return ids.length === 1 ? `update_id:${ids[0]}` : `update_id:[${ids.join(",")}]`;
}

/** Ask Sentry for the counts. */
async function fetchHealthRows(updateIds, env = process.env, fetchImpl = globalThis.fetch, period = "14d") {
  const project = projectIdFromEnv(env);
  if (!env.SENTRY_OPS_TOKEN || !env.SENTRY_ORG || !project) throw new Error("Need SENTRY_OPS_TOKEN, SENTRY_ORG and a project id or DSN (run through creds.mjs).");
  const qs = new URLSearchParams([
    ["field", "ota_event"], ["field", "count_unique(user)"], ["field", "count()"],
    ["query", discoverQuery(updateIds)], ["statsPeriod", period], ["project", project], ["dataset", "errors"], ["per_page", "50"],
  ]);
  const res = await fetchImpl(`https://sentry.io/api/0/organizations/${env.SENTRY_ORG}/events/?${qs}`, { headers: { authorization: `Bearer ${env.SENTRY_OPS_TOKEN}` } });
  if (!res.ok) throw new Error(`Sentry answered ${res.status}`);
  return rowsFromDiscover(await res.json());
}

module.exports = { DEFAULT_THRESHOLDS, evaluateHealth, rowsFromDiscover, projectIdFromEnv, discoverQuery, fetchHealthRows };
