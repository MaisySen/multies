#!/usr/bin/env node
/* global __dirname */
/**
 * Publish an over the air update (EAS Update) after the guard in scripts/ota-guard.js says it is safe.
 *
 *   npm run ota:preview -- --message "Fix the task list spacing"
 *   npm run ota:production -- --message "Fix the task list spacing"
 *   node scripts/ota.js preview --check      (run the guard only)
 *
 * See docs/OTA.md. Needs EXPO_TOKEN (or `eas login`) for the publish step.
 */
const { execFileSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");
const { bundleEnv, commitsFromViews, evaluateGuard, groupIdsFromList, nativeChanges } = require("./ota-guard");

const root = join(__dirname, "..");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const git = (...args) => run("git", args).trim();

function fingerprint(platform) {
  const out = run("npx", ["expo-updates", "fingerprint:generate", "--platform", platform]);
  return JSON.parse(out.slice(out.indexOf("{"))).hash;
}

function fileAt(commit, path) {
  try { return JSON.parse(git("show", `${commit}:${path}`)); } catch { return null; }
}

function easJson(args) {
  const out = run("eas", [...args, "--json"]);
  return JSON.parse(out.slice(out.search(/[[{]/)));
}

/** Commits already published to the preview branch (newest 10 update groups). */
function previewCommits() {
  const groups = groupIdsFromList(easJson(["update:list", "--branch", "preview", "--limit", "20", "--non-interactive"])).slice(0, 10);
  return commitsFromViews(groups.map((g) => easJson(["update:view", g])));
}

function main() {
  const argv = process.argv.slice(2);
  const channel = argv[0];
  const checkOnly = argv.includes("--check");
  const mi = argv.indexOf("--message");
  const head = git("rev-parse", "HEAD");
  const message = mi >= 0 ? argv[mi + 1] : git("log", "-1", "--format=%s");

  const store = JSON.parse(readFileSync(join(root, "store", "runtime-versions.json"), "utf8"));
  const since = store.commit;
  const files = since ? git("diff", "--name-only", `${since}..HEAD`).split("\n").filter(Boolean) : [];
  const nativeFiles = nativeChanges(
    files,
    { before: fileAt(since, "app.json"), after: fileAt("HEAD", "app.json") },
    { before: fileAt(since, "package.json"), after: fileAt("HEAD", "package.json") },
  );
  const current = { android: fingerprint("android"), ios: fingerprint("ios") };
  const dirty = git("status", "--porcelain") !== "";
  const result = evaluateGuard({ channel, dirty, current, store, nativeFiles, head, previewCommits: channel === "production" ? previewCommits() : [] });

  console.log(`Channel: ${channel}`);
  console.log(`Runtime versions now: android ${current.android}, ios ${current.ios}`);
  if (!result.ok) {
    console.error("\nNot publishing:");
    for (const p of result.problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log("Guard passed: JavaScript only change on the same native build.");
  if (checkOnly) return;

  const env = { ...process.env, ...bundleEnv(JSON.parse(readFileSync(join(root, "eas.json"), "utf8")), channel) };
  execFileSync("eas", ["update", "--channel", channel, "--environment", channel, "--message", message, "--non-interactive"], { cwd: root, env, stdio: "inherit" });
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message || e); process.exit(1); }
}
