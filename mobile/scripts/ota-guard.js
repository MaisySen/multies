/**
 * The guard in front of `npm run ota:preview` and `npm run ota:production` (docs/OTA.md).
 *
 * An over the air update may only carry JavaScript and assets. If the native side of the app changed
 * since the last store build, phones on that build cannot run the new code, so the update must not go
 * out and a new store build is needed instead. Two independent checks say so:
 *   1. the fingerprint (runtime version) of the project now differs from the one the store build
 *      was made with (store/runtime-versions.json), for either platform;
 *   2. a file that shapes the native app changed since the store build's commit.
 * Production also needs the same commit on the preview channel first.
 *
 * Pure functions here, so they can be unit tested; scripts/ota.js does the git and EAS calls.
 */

const CHANNELS = ["preview", "production"];
const PLATFORMS = ["android", "ios"];

/** Paths that change the native app when they change (beyond what the fingerprint already sees). */
const NATIVE_PATTERNS = [
  /^android\//,
  /^ios\//,
  /^plugins\//,
  /^patches\//,
  /^fingerprint\.config\.js$/,
  /^\.fingerprintignore$/,
  /^google-services\.json$/,
  /^GoogleService-Info\.plist$/,
];

/** Fields of app.json that only number builds and never change native code. */
function stripVersions(appJson) {
  const c = JSON.parse(JSON.stringify(appJson || {}));
  const e = c.expo || c;
  delete e.version;
  if (e.ios) delete e.ios.buildNumber;
  if (e.android) delete e.android.versionCode;
  return c;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Which changed files touch the native app. `files` are the paths changed since the store build;
 * `appJson` and `packageJson` hold { before, after } parsed contents for the two files that can carry
 * both native and harmless changes.
 */
function nativeChanges(files, appJson, packageJson) {
  const out = [];
  for (const f of files) {
    if (NATIVE_PATTERNS.some((re) => re.test(f))) out.push(f);
  }
  if (files.includes("app.json") && appJson && !sameJson(stripVersions(appJson.before), stripVersions(appJson.after))) {
    out.push("app.json");
  }
  if (files.includes("package.json") && packageJson) {
    const b = packageJson.before || {};
    const a = packageJson.after || {};
    if (!sameJson(b.dependencies || {}, a.dependencies || {})) out.push("package.json (dependencies)");
  }
  return out;
}

/**
 * Decide whether an update may go out.
 * @param {object} o
 * @param {string} o.channel preview or production
 * @param {boolean} o.dirty uncommitted changes in the working tree
 * @param {{android?: string, ios?: string}} o.current fingerprints now
 * @param {{android?: {runtimeVersion: string}, ios?: {runtimeVersion: string}}} o.store the last store builds
 * @param {string[]} o.nativeFiles result of nativeChanges()
 * @param {string} o.head the commit being published
 * @param {string[]} [o.previewCommits] commits already published to the preview channel
 * @param {boolean} [o.whatsNewCurrent] false when src/lib/ota/whats-new.generated.ts no longer matches CHANGELOG.md
 * @returns {{ ok: boolean, problems: string[] }}
 */
function evaluateGuard(o) {
  const problems = [];
  if (!CHANNELS.includes(o.channel)) {
    problems.push(`Unknown channel "${o.channel}". Use preview or production.`);
  }
  if (o.dirty) {
    problems.push("There are uncommitted changes. Commit first, so every update maps to a commit.");
  }
  for (const p of PLATFORMS) {
    const built = o.store && o.store[p] && o.store[p].runtimeVersion;
    const now = o.current && o.current[p];
    if (!built) {
      problems.push(`No store build is recorded for ${p} in store/runtime-versions.json.`);
    } else if (!now) {
      problems.push(`Could not work out the ${p} fingerprint.`);
    } else if (built !== now) {
      problems.push(
        `The ${p} fingerprint changed (store build ${built.slice(0, 10)}, now ${now.slice(0, 10)}). ` +
          "Native code or config changed: make a new store build instead of an update.",
      );
    }
  }
  if (o.nativeFiles && o.nativeFiles.length) {
    problems.push(
      `Native files changed since the store build: ${o.nativeFiles.join(", ")}. Make a new store build instead of an update.`,
    );
  }
  if (o.whatsNewCurrent === false) {
    problems.push("The What's new notes are out of date with CHANGELOG.md. Run npm run whats-new and commit.");
  }
  if (o.channel === "production") {
    const seen = (o.previewCommits || []).some((c) => c && o.head && (c.startsWith(o.head) || o.head.startsWith(c)));
    if (!seen) {
      problems.push("This commit is not on the preview channel yet. Run npm run ota:preview first and check it on a test phone.");
    }
  }
  return { ok: problems.length === 0, problems };
}

/** The env an update is bundled with: the same EXPO_PUBLIC_* values as the build profile of that channel. */
function bundleEnv(easJson, channel) {
  const profiles = (easJson && easJson.build) || {};
  const name = Object.keys(profiles).find((k) => profiles[k].channel === channel && !profiles[k].extends) ||
    Object.keys(profiles).find((k) => profiles[k].channel === channel);
  if (!name) throw new Error(`No build profile in eas.json uses channel ${channel}.`);
  const env = {};
  for (const [k, v] of Object.entries(profiles[name].env || {})) {
    if (k.startsWith("EXPO_PUBLIC_")) env[k] = String(v);
  }
  return env;
}

/** Update group ids from `eas update:list --branch <b> --json` ({ currentPage: [{ group }] }), newest first, no repeats. */
function groupIdsFromList(list) {
  const rows = (list && (list.currentPage || list.updates)) || (Array.isArray(list) ? list : []);
  const seen = [];
  for (const r of rows) if (r && r.group && !seen.includes(r.group)) seen.push(r.group);
  return seen;
}

/** Commit hashes from `eas update:view <group> --json` results (arrays of updates). */
function commitsFromViews(views) {
  return views.flat().map((u) => u && u.gitCommitHash).filter(Boolean);
}

/**
 * The newest update group per platform from `eas update:list --branch <b> --json`. Each platform has
 * its own runtime version (fingerprint), so one publish makes one group per platform.
 */
function latestGroupsByPlatform(list) {
  const rows = (list && (list.currentPage || list.updates)) || (Array.isArray(list) ? list : []);
  const out = [];
  for (const r of rows) {
    if (!r || !r.group) continue;
    for (const p of String(r.platforms || r.platform || "").split(/[,\s]+/).filter(Boolean)) {
      if (!PLATFORMS.includes(p) || out.some((g) => g.platform === p)) continue;
      out.push({ platform: p, group: r.group, runtimeVersion: r.runtimeVersion, message: String(r.message || "").replace(/^"|"\s*\(.*$/g, "").replace(/"$/, ""), isRollBackToEmbedded: !!r.isRollBackToEmbedded, rollout: rolloutOf([r]) });
    }
  }
  return out;
}

/** The rollout percentage of an update group (`rolloutPercentage` on `eas update:list --json` rows), or null when it reaches every phone. */
function rolloutOf(updates) {
  for (const u of updates || []) {
    const p = u && (u.rolloutPercentage ?? (u.rollout && u.rollout.percentage));
    if (typeof p === "number" && p < 100) return p;
  }
  return null;
}

/** `--name value`, `--flag` and positional arguments. */
function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[k] = next; i++; } else out[k] = true;
  }
  return out;
}

module.exports = { latestGroupsByPlatform, rolloutOf, parseFlags, groupIdsFromList, commitsFromViews, CHANNELS, PLATFORMS, NATIVE_PATTERNS, nativeChanges, evaluateGuard, bundleEnv, stripVersions };
