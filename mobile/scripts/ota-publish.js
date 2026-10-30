#!/usr/bin/env node
/* global __dirname, Buffer */
/**
 * Publish an over the air update only to the store builds phones actually have, and prove it landed.
 * See RELEASING.md. Run through the credentials helper so EXPO_TOKEN is set (never printed):
 *
 *   node ../app/scripts/creds.mjs run EXPO_TOKEN -- node scripts/ota-publish.js production --check
 *   node ../app/scripts/creds.mjs run EXPO_TOKEN -- node scripts/ota-publish.js preview
 *   node ../app/scripts/creds.mjs run EXPO_TOKEN -- node scripts/ota-publish.js production
 *
 * Steps:
 *  a. Reads the live store builds: iOS from App Store Connect (TestFlight builds that are VALID and
 *     not expired) joined to `eas build:list` for their runtime versions; Android from the Play
 *     tracks joined to store/android-builds.json (Android bundles are built locally, so EAS does not
 *     know them; a live version code missing from that file is a refusal).
 *  b. Computes this code's fingerprint per platform and REFUSES unless it equals the runtime of the
 *     newest live store build on each platform. Also refuses: uncommitted changes, native files
 *     changed since the store build's commit, stale What's new, production without the same commit
 *     on preview first.
 *  c. Publishes with `eas update` on the channel, bundled with that channel's EXPO_PUBLIC_* env.
 *  d. Asks the update server (u.expo.dev, protocol 1) for each targeted runtime on that channel and
 *     FAILS unless it answers with the new update id (retries for up to 2 minutes).
 *  e. Prints one summary line.
 *
 * Flags: --check (stop after b), --verify-only (skip c, check d against the current update ids on
 * the channel), --message "...", --rollout 10, --critical, --runtime ios=<hash>,android=<hash>
 * (drill only: pretend the code has these runtimes; never publishes).
 * Secrets are read from files under ~/.multies-secrets (paths overridable by env) and never printed.
 */
const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");
const os = require("os");
const crypto = require("crypto");
const { bundleEnv, commitsFromViews, evaluateGuard, groupIdsFromList, nativeChanges, parseFlags } = require("./ota-guard");
const { liveIos, liveAndroid, checkRuntimes, manifestIdFrom, parseRuntimeOverride, PLATFORMS } = require("./ota-live");
const whatsNew = require("./whats-new");

const root = join(__dirname, "..");
const SECRETS = process.env.MULTIES_SECRETS_DIR || join(os.homedir(), ".multies-secrets");
const PLAY_PACKAGE = "au.fintex.multies";
const ASC_APP_ID = "6826562106";
const ASC_KEY_ID = process.env.ASC_KEY_ID || "GQ43YP4N5K";
const ASC_ISSUER_ID = process.env.ASC_ISSUER_ID || "de0b7491-5b63-4b19-b34f-f7cea7fe5395";
const appJson = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
const UPDATE_URL = appJson.expo.updates.url;

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
const git = (...args) => run("git", args).trim();
const b64u = (x) => Buffer.from(x).toString("base64url");
const log = (...a) => console.log(...a);

function easJson(args) {
  if (!process.env.EXPO_TOKEN) throw new Error("EXPO_TOKEN is not set. Run through node ../app/scripts/creds.mjs run EXPO_TOKEN -- ...");
  const out = run("eas", [...args, "--json", ...(args[0] === "update:view" ? [] : ["--non-interactive"])]);
  return JSON.parse(out.slice(out.search(/[[{]/)));
}

function fingerprint(platform) {
  const out = run("npx", ["expo-updates", "fingerprint:generate", "--platform", platform]);
  return JSON.parse(out.slice(out.indexOf("{"))).hash;
}

async function playTracks() {
  const sa = JSON.parse(readFileSync(process.env.PLAY_SERVICE_ACCOUNT || join(SECRETS, "play-service-account.json"), "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 1200 }))}`;
  const jwt = `${unsigned}.${crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url")}`;
  const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }) });
  if (!t.ok) throw new Error(`Play sign in failed (${t.status}).`);
  const H = { authorization: `Bearer ${(await t.json()).access_token}` };
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}`;
  const e = await (await fetch(`${base}/edits`, { method: "POST", headers: H })).json();
  if (!e.id) throw new Error("Play did not open a read edit.");
  try {
    const r = await fetch(`${base}/edits/${e.id}/tracks`, { headers: H });
    if (!r.ok) throw new Error(`Play tracks read failed (${r.status}).`);
    return await r.json();
  } finally {
    await fetch(`${base}/edits/${e.id}`, { method: "DELETE", headers: H }).catch(() => {});
  }
}

async function ascBuilds() {
  const p8 = readFileSync(process.env.ASC_KEY_PATH || join(SECRETS, `AuthKey_${ASC_KEY_ID}.p8`), "utf8");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64u(JSON.stringify({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" }))}.${b64u(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" }))}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: crypto.createPrivateKey(p8), dsaEncoding: "ieee-p1363" }).toString("base64url");
  const r = await fetch(`https://api.appstoreconnect.apple.com/v1/builds?filter[app]=${ASC_APP_ID}&sort=-uploadedDate&limit=20&include=preReleaseVersion`, { headers: { authorization: `Bearer ${unsigned}.${sig}` } });
  if (!r.ok) throw new Error(`App Store Connect builds read failed (${r.status}).`);
  const j = await r.json();
  const versions = Object.fromEntries((j.included || []).filter((i) => i.type === "preReleaseVersions").map((i) => [i.id, i.attributes.version]));
  return (j.data || []).map((b) => ({
    buildNumber: b.attributes.version,
    version: versions[b.relationships.preReleaseVersion.data.id],
    processingState: b.attributes.processingState,
    expired: b.attributes.expired,
    uploadedDate: b.attributes.uploadedDate,
  }));
}

async function readLive() {
  const [asc, tracks] = await Promise.all([ascBuilds(), playTracks()]);
  const eas = easJson(["build:list", "--platform", "ios", "--status", "finished", "--limit", "30"]);
  const record = JSON.parse(readFileSync(join(root, "store", "android-builds.json"), "utf8"));
  return { ios: liveIos(asc, eas), android: liveAndroid(tracks, record) };
}

async function askUpdateServer(platform, runtimeVersion, channel) {
  const r = await fetch(UPDATE_URL, { headers: { "expo-platform": platform, "expo-runtime-version": runtimeVersion, "expo-channel-name": channel, "expo-protocol-version": "1", accept: "multipart/mixed,application/expo+json,application/json" } });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`Update server answered ${r.status} for ${platform} ${runtimeVersion.slice(0, 8)}.`);
  return manifestIdFrom(await r.text(), r.headers.get("content-type"));
}

async function verify(targets, channel, expected) {
  const results = [];
  for (const t of targets) {
    const want = expected[t.platform];
    let got = null;
    const deadline = Date.now() + 120000;
    for (;;) {
      got = await askUpdateServer(t.platform, t.runtimeVersion, channel);
      if (!want || got === want || Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 10000));
    }
    results.push({ ...t, got, want, ok: !!want && got === want });
  }
  return results;
}

function previewCommits() {
  const groups = groupIdsFromList(easJson(["update:list", "--branch", "preview", "--limit", "20"])).slice(0, 10);
  return commitsFromViews(groups.map((g) => easJson(["update:view", g])));
}

function fileAt(commit, path) {
  try { return JSON.parse(git("show", `${commit}:${path}`)); } catch { return null; }
}

/** Current update id per platform on a channel's branch (for --verify-only). */
function currentIds(channel) {
  const list = easJson(["update:list", "--branch", channel, "--limit", "10"]);
  const rows = (list && (list.currentPage || list.updates)) || [];
  const out = {};
  for (const r of rows) {
    const view = easJson(["update:view", r.group]);
    for (const u of Array.isArray(view) ? view : []) if (u.platform && !out[u.platform]) out[u.platform] = { id: u.id, runtimeVersion: u.runtimeVersion };
    if (out.ios && out.android) break;
  }
  return out;
}

async function main() {
  const [channel, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (!["preview", "production"].includes(channel)) throw new Error("Usage: node scripts/ota-publish.js preview|production [--check] [--verify-only] [--message ...] [--rollout N] [--critical] [--runtime ios=..,android=..]");
  const override = parseRuntimeOverride(flags.runtime);
  const drill = Object.keys(override).length > 0;

  // a. live store builds
  const live = await readLive();
  for (const p of PLATFORMS) {
    for (const b of live[p]) log(`live ${p}: ${b.version} (${b.build}) ${b.where}, runtime ${b.runtimeVersion ? b.runtimeVersion.slice(0, 8) : b.updatable ? "UNKNOWN" : "none (no updater)"}`);
  }

  // b. this code's runtime against them
  const current = drill ? { ...override } : { ios: fingerprint("ios"), android: fingerprint("android") };
  log(`this code: ios ${String(current.ios).slice(0, 8)}, android ${String(current.android).slice(0, 8)}${drill ? " (drill: --runtime given)" : ""}`);
  const rt = checkRuntimes({ live, current, channel });
  const problems = [...rt.problems];
  if (!drill) {
    const head = git("rev-parse", "HEAD");
    const since = (live.ios[0] && live.ios[0].commit) || (live.android[0] && live.android[0].commit);
    const files = since ? git("diff", "--name-only", `${since}..HEAD`).split("\n").filter(Boolean) : [];
    const nativeFiles = nativeChanges(files, { before: fileAt(since, "app.json"), after: fileAt("HEAD", "app.json") }, { before: fileAt(since, "package.json"), after: fileAt("HEAD", "package.json") });
    const store = {};
    for (const p of PLATFORMS) store[p] = { runtimeVersion: current[p] }; // runtimes already compared above
    const g = evaluateGuard({ channel, dirty: git("status", "--porcelain") !== "", current, store, nativeFiles, head, previewCommits: channel === "production" && !flags["verify-only"] ? previewCommits() : [], whatsNewCurrent: whatsNew.upToDate() });
    for (const p of g.problems) if (!(flags["verify-only"] && /preview channel|uncommitted/.test(p))) problems.push(p);
  }
  if (problems.length) {
    console.error(`\nREFUSED (${channel}):`);
    for (const p of problems) console.error(`- ${p}`);
    log(`ota-publish: REFUSED ${channel}, ${problems.length} problem(s), nothing published`);
    process.exit(1);
  }
  log(`Runtime check passed: targets ${rt.targets.map((t) => `${t.platform} ${t.version} (${t.build}) ${t.runtimeVersion.slice(0, 8)}`).join(", ")}`);
  for (const s of rt.skipped) log(`not targeted (other runtime): ${s.platform} ${s.version} (${s.build}) ${s.where}`);
  if (drill || flags.check) {
    log(`ota-publish: CHECK OK ${channel}, would publish for ${rt.targets.map((t) => `${t.platform} ${t.runtimeVersion.slice(0, 8)}`).join(" + ")}`);
    return;
  }

  // c. publish
  let expected = {};
  if (flags["verify-only"]) {
    const cur = currentIds(channel);
    for (const p of PLATFORMS) if (cur[p]) expected[p] = cur[p].id;
  } else {
    const rollout = flags.rollout != null ? Number(flags.rollout) : null;
    if (rollout != null && (!Number.isInteger(rollout) || rollout < 1 || rollout > 100)) throw new Error("--rollout takes a whole percentage from 1 to 100.");
    const env = { ...process.env, ...bundleEnv(JSON.parse(readFileSync(join(root, "eas.json"), "utf8")), channel) };
    const args = ["update", "--channel", channel, "--environment", channel, "--message", flags.message || git("log", "-1", "--format=%s").slice(0, 200), "--non-interactive", "--json"];
    if (rollout != null && rollout < 100) args.push("--rollout-percentage", String(rollout));
    const out = execFileSync("eas", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
    const rows = JSON.parse(out.slice(out.search(/[[{]/)));
    for (const u of Array.isArray(rows) ? rows : []) {
      expected[u.platform] = u.id;
      log(`published ${u.platform}: update ${u.id}, group ${u.group}, runtime ${String(u.runtimeVersion).slice(0, 8)}`);
      const t = rt.targets.find((x) => x.platform === u.platform);
      if (t && u.runtimeVersion !== t.runtimeVersion) problems.push(`${u.platform}: EAS published runtime ${String(u.runtimeVersion).slice(0, 8)}, not the store build's ${t.runtimeVersion.slice(0, 8)}.`);
    }
    if (flags.critical && rows.length) {
      await require("./ota").patchAppConfig({ ota: { add_critical_update_ids: rows.map((u) => u.id).slice(0, 10) } }, "marked critical (phones apply it at once)");
    }
    if (rollout != null && rollout < 100) log("Staged rollout: phones outside the rollout keep the previous update; the server check below may show the old id for them.");
  }

  // d. ask the update server, per live runtime
  const results = await verify(rt.targets, channel, expected);
  for (const r of results) log(`update server ${r.platform} ${r.runtimeVersion.slice(0, 8)} on ${channel}: ${r.got || "no update (204)"}${r.ok ? " OK" : ` FAIL (want ${r.want || "none"})`}`);
  const bad = results.filter((r) => !r.ok);
  if (bad.length || problems.length) {
    for (const p of problems) console.error(`- ${p}`);
    log(`ota-publish: FAILED ${channel}, the update server does not serve the new update to ${bad.map((b) => `${b.platform} ${b.version} (${b.build})`).join(", ") || "every target"}`);
    process.exit(2);
  }
  // e. summary
  log(`ota-publish: OK ${channel} ${results.map((r) => `${r.platform} ${r.version}(${r.build}) rt ${r.runtimeVersion.slice(0, 8)} -> ${r.got}`).join("; ")}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); console.log("ota-publish: ERROR, nothing confirmed"); process.exit(1); });
module.exports = { main };
