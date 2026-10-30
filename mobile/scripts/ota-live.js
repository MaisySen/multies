/**
 * Pure helpers for scripts/ota-publish.js (RELEASING.md). No network, no git: unit tested in
 * __tests__/ota-live.test.ts.
 *
 * "Live store build" means a build a phone can install today:
 *   iOS: a TestFlight (App Store Connect) build that is processed (VALID) and not expired.
 *   Android: a version code in a completed or in progress release on any Play track.
 * Each platform's target is its newest live build. An update may only go out when the code's
 * runtime version (fingerprint) equals that build's runtime version.
 */

const PLATFORMS = ["android", "ios"];

/** Builds with an updater: older store builds have no expo-updates and can never take an OTA. */
const FIRST_UPDATABLE = { ios: 17, android: 15 };

/**
 * iOS live builds. `asc` holds App Store Connect builds [{ buildNumber, version, processingState,
 * expired, uploadedDate }]; `eas` holds `eas build:list --platform ios --json` rows. The runtime comes
 * from the EAS build with the same version and build number.
 */
function liveIos(asc, eas) {
  const out = [];
  for (const b of asc || []) {
    if (b.processingState !== "VALID" || b.expired) continue;
    const n = Number(b.buildNumber);
    const match = (eas || []).find(
      (e) => String(e.platform).toUpperCase() === "IOS" && String(e.appBuildVersion) === String(b.buildNumber) &&
        String(e.appVersion) === String(b.version) && String(e.status || "FINISHED").toUpperCase() === "FINISHED",
    );
    const runtimeVersion = (match && ((match.runtime && match.runtime.version) || match.runtimeVersion)) || null;
    out.push({
      platform: "ios",
      build: n,
      version: b.version,
      where: "TestFlight",
      runtimeVersion,
      channel: (match && match.updateChannel && match.updateChannel.name) || (match && match.channel) || null,
      commit: (match && match.gitCommitHash) || null,
      updatable: n >= FIRST_UPDATABLE.ios,
    });
  }
  return out.sort((a, b) => b.build - a.build);
}

/**
 * Android live builds. `tracks` is the Play edits.tracks.list result ({ tracks: [...] }); `record` is
 * store/android-builds.json (version code -> runtime, written when the bundle is uploaded, because
 * Android bundles are built locally and EAS has no record of them).
 */
function liveAndroid(tracks, record) {
  const byCode = new Map();
  for (const t of (tracks && tracks.tracks) || []) {
    for (const r of t.releases || []) {
      if (!["completed", "inProgress"].includes(r.status)) continue;
      for (const vc of r.versionCodes || []) {
        const n = Number(vc);
        const prev = byCode.get(n);
        const where = `Play ${t.track}`;
        if (prev) { prev.where += `, ${where}`; continue; }
        const rec = (record && record.builds && record.builds[String(n)]) || null;
        byCode.set(n, {
          platform: "android",
          build: n,
          version: (rec && rec.version) || (r.name || "").replace(/\s*\(.*\)$/, "") || null,
          where,
          runtimeVersion: (rec && rec.runtimeVersion) || null,
          channel: (rec && rec.channel) || null,
          commit: (rec && rec.commit) || null,
          updatable: n >= FIRST_UPDATABLE.android,
        });
      }
    }
  }
  return [...byCode.values()].sort((a, b) => b.build - a.build);
}

/**
 * The decision. `live` is { ios: [...], android: [...] } from the two functions above, newest first.
 * `current` is { ios, android } fingerprints of the code to publish.
 * @returns {{ ok: boolean, problems: string[], targets: object[], skipped: object[] }}
 */
function checkRuntimes({ live, current, channel }) {
  const problems = [];
  const targets = [];
  const skipped = [];
  for (const p of PLATFORMS) {
    const builds = (live && live[p]) || [];
    const newest = builds[0];
    if (!newest) {
      problems.push(`No live ${p} store build was found (${p === "ios" ? "TestFlight" : "Play tracks"}). Refusing: nothing to target.`);
      continue;
    }
    for (const b of builds.slice(1)) skipped.push(b);
    if (!newest.updatable) {
      problems.push(`The newest live ${p} build (${newest.version} build ${newest.build}) has no updater. Make a store build.`);
      continue;
    }
    if (!newest.runtimeVersion) {
      problems.push(
        p === "android"
          ? `Play has versionCode ${newest.build} live but store/android-builds.json has no runtime for it. Record it (runtime from the bundle's fingerprint) before publishing.`
          : `TestFlight has build ${newest.build} live but no finished EAS build matches it, so its runtime is unknown.`,
      );
      continue;
    }
    if (channel && newest.channel && newest.channel !== "production" && channel === "production") {
      problems.push(`The newest live ${p} build listens to channel ${newest.channel}, not production.`);
    }
    const now = current && current[p];
    if (!now) {
      problems.push(`Could not work out the ${p} fingerprint of this code.`);
    } else if (now !== newest.runtimeVersion) {
      problems.push(
        `${p}: this code has runtime ${now.slice(0, 8)} but the live store build ${newest.version} (${newest.build}, ${newest.where}) has runtime ${newest.runtimeVersion.slice(0, 8)}. ` +
          "Phones on that build would never get this update. Check out the code line of that build, or make a store build.",
      );
    } else {
      targets.push(newest);
    }
    // Older live builds that share the runtime get the update too; others are reported, not targeted.
    for (const b of builds.slice(1)) if (b.runtimeVersion && b.runtimeVersion === now && !targets.includes(b)) targets.push(b);
  }
  return { ok: problems.length === 0, problems, targets, skipped: skipped.filter((b) => !targets.includes(b)) };
}

/** The update id from an expo-updates protocol 1 response (multipart/mixed or plain JSON). */
function manifestIdFrom(body, contentType) {
  const text = String(body || "");
  if (/multipart\/mixed/i.test(contentType || "")) {
    const m = String(contentType).match(/boundary="?([^";]+)"?/i);
    const parts = m ? text.split(`--${m[1]}`) : [text];
    for (const part of parts) {
      if (!/name="manifest"/i.test(part)) continue;
      const json = part.slice(part.search(/\r?\n\r?\n/)).trim();
      try { return JSON.parse(json).id || null; } catch { return null; }
    }
    return null;
  }
  try { const j = JSON.parse(text); return j.id || (j.manifest && j.manifest.id) || null; } catch { return null; }
}

/** "ios=abc,android=def" -> { ios: "abc", android: "def" } */
function parseRuntimeOverride(s) {
  const out = {};
  for (const kv of String(s || "").split(",")) {
    const [k, v] = kv.split("=").map((x) => (x || "").trim());
    if (PLATFORMS.includes(k) && v) out[k] = v;
  }
  return out;
}

module.exports = { PLATFORMS, FIRST_UPDATABLE, liveIos, liveAndroid, checkRuntimes, manifestIdFrom, parseRuntimeOverride };
