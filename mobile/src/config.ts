import Constants from "expo-constants";
import { Platform } from "react-native";

const extra = (Constants.expoConfig?.extra ?? {}) as { apiBase?: string; eas?: { projectId?: string } };

/** Production by default. EXPO_PUBLIC_API_BASE points a build at staging or a local server. */
export const API_BASE = (process.env.EXPO_PUBLIC_API_BASE || extra.apiBase || "https://multies.si").replace(/\/$/, "");

/** The browser preview can't sign in across sites, so it only offers the sample workspace. */
export const SAMPLE_ONLY = Platform.OS === "web" || process.env.EXPO_PUBLIC_SAMPLE_ONLY === "1";

/**
 * Sign in. The app opens the Multies sign in page (the identity provider's Universal Login)
 * in the system browser as a public native client with PKCE, then trades the ID token for a
 * Multies session at /api/auth/mobile/exchange. None of these values is a secret.
 */
export const IDP = {
  domain: (process.env.EXPO_PUBLIC_IDP_DOMAIN || "dev-s8n2ciq6co7gzsec.us.auth0.com").replace(/^https?:\/\//, "").replace(/\/$/, ""),
  clientId: process.env.EXPO_PUBLIC_IDP_CLIENT_ID || "c0Ok2GtCfLW6BSetucyNAmX2qxypUEI0",
  /** The app.json scheme ("mymail") plus a fixed path; registered as the client's callback. */
  redirectUri: "mymail://auth/callback",
};

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
  /** The published Fintex pages, the same URLs the store listings give (store/apple/listing.md). */
  privacy: "https://multies.si/privacy/",
  terms: "https://multies.si/terms/",
  accountSettings: `${API_BASE}/app/settings/account`,
  deleteAccount: `${API_BASE}/delete-account`,
  status: `${API_BASE}/status`,
  support: "https://multies.si/support/",
};
