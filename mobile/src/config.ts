import Constants from "expo-constants";
import { Platform } from "react-native";

const extra = (Constants.expoConfig?.extra ?? {}) as { apiBase?: string; eas?: { projectId?: string } };

/** Production by default. EXPO_PUBLIC_API_BASE points a build at staging or a local server. */
export const API_BASE = (process.env.EXPO_PUBLIC_API_BASE || extra.apiBase || "https://mymail.mymail-app.workers.dev").replace(/\/$/, "");

/** The browser preview can't sign in across sites, so it only offers the sample workspace. */
export const SAMPLE_ONLY = Platform.OS === "web" || process.env.EXPO_PUBLIC_SAMPLE_ONLY === "1";

export const EAS_PROJECT_ID = extra.eas?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? null;

/** Reads a build flag. Expo inlines EXPO_PUBLIC_ values only when written out in full, so callers pass process.env.X itself. */
function flag(v: string | undefined, fallback: boolean) {
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true";
}

/**
 * Feature flags.
 * tasks: the Tasks tab and "Make task" on a thread, backed by /api/tasks.
 * pushServer: registers this phone's push token with POST /api/push/devices after sign in. On by
 * default. Harmless when the server has push switched off (it keeps the token and sends nothing)
 * or when the build has no EAS project id (no token is fetched at all). EXPO_PUBLIC_FEATURE_PUSH_SERVER=0
 * turns it off for a build.
 */
export const FEATURES = {
  tasks: flag(process.env.EXPO_PUBLIC_FEATURE_TASKS, true),
  pushServer: flag(process.env.EXPO_PUBLIC_FEATURE_PUSH_SERVER, true),
};

export const LINKS = {
  signup: `${API_BASE}/signup`,
  forgotPassword: `${API_BASE}/forgot-password`,
  privacy: `${API_BASE}/privacy`,
  terms: `${API_BASE}/terms`,
  accountSettings: `${API_BASE}/app/settings/account`,
  status: `${API_BASE}/status`,
  support: "mailto:support@mymail.au?subject=MyMail%20app",
};
