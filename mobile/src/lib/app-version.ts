import * as Application from "expo-application";
import * as Updates from "expo-updates";

/**
 * The version of the JavaScript in this app. A store build ships with the same number as the store
 * version; an over the air update (EAS Update, see docs/OTA.md) may raise it without a new store
 * build, and Settings then shows it with "(OTA)".
 */
export const JS_VERSION = "1.9.12";

export type VersionFacts = {
  jsVersion: string;
  nativeVersion: string | null;
  nativeBuild: string | null;
  /** True when the app runs the bundle inside the store build (no update applied). */
  embedded: boolean;
  updateId: string | null;
  channel: string | null;
  /** The fingerprint the store build was made with (EAS runtime version). */
  runtimeVersion?: string | null;
};

/** The line at the bottom of Settings, for example "Multies 1.9.3 (17)" or "Multies 1.9.4 (OTA)". */
export function versionLabel(f: VersionFacts): string {
  const native = f.nativeVersion ?? "1.0.0";
  const build = f.nativeBuild ? ` (${f.nativeBuild})` : "";
  if (f.embedded || !f.updateId) return `Multies ${native}${build}`;
  const js = f.jsVersion === native ? f.jsVersion : `${f.jsVersion} (OTA)`;
  return `Multies ${js}`;
}

/** The small print under it: which update is running and on which channel, or nothing. */
export function updateDetail(f: VersionFacts): string | null {
  if (f.embedded || !f.updateId) return null;
  const parts = [`Update ${f.updateId.slice(0, 8)}`];
  if (f.channel) parts.push(`channel ${f.channel}`);
  const native = f.nativeVersion ?? "1.0.0";
  parts.push(`store build ${native}${f.nativeBuild ? ` (${f.nativeBuild})` : ""}`);
  return parts.join(", ");
}

export function currentVersionFacts(): VersionFacts {
  let embedded = true;
  let updateId: string | null = null;
  let channel: string | null = null;
  let runtimeVersion: string | null = null;
  try {
    embedded = Updates.isEmbeddedLaunch ?? true;
    updateId = Updates.updateId ?? null;
    channel = Updates.channel ?? null;
    runtimeVersion = Updates.runtimeVersion ?? null;
  } catch {
    // expo-updates is not available (web, tests): treat as the built in bundle.
  }
  return {
    jsVersion: JS_VERSION,
    nativeVersion: Application.nativeApplicationVersion ?? null,
    nativeBuild: Application.nativeBuildVersion ?? null,
    embedded,
    updateId,
    channel,
    runtimeVersion,
  };
}
