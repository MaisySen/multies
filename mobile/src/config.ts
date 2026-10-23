import Constants from "expo-constants";
import { Platform } from "react-native";

const extra = (Constants.expoConfig?.extra ?? {}) as { apiBase?: string; eas?: { projectId?: string } };

/** Production by default. EXPO_PUBLIC_API_BASE points a build at staging or a local server. */
export const API_BASE = (process.env.EXPO_PUBLIC_API_BASE || extra.apiBase || "https://mymail.mymail-app.workers.dev").replace(/\/$/, "");

/** The browser preview can't sign in across sites, so it only offers the sample workspace. */
export const SAMPLE_ONLY = Platform.OS === "web" || process.env.EXPO_PUBLIC_SAMPLE_ONLY === "1";

export const EAS_PROJECT_ID = extra.eas?.projectId ?? process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? null;

function flag(name: string, fallback: boolean) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v === "true";
}

/**
 * Feature flags.
 * tasks: the web API has no tasks endpoints yet, so tasks live on this device until it does.
 * pushServer: registers the device's push token with the API. Off until the API has
 * POST /api/push/devices (see docs/push.md).
 */
export const FEATURES = {
  tasks: flag("EXPO_PUBLIC_FEATURE_TASKS", true),
  pushServer: flag("EXPO_PUBLIC_FEATURE_PUSH_SERVER", false),
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
