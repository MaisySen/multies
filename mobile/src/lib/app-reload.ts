import { DevSettings, Platform } from "react-native";

/**
 * MPAR2: starts the app again so a new language or appearance applies to every screen at once (colours and words are
 * chosen when the app starts). Phones reload the current bundle through expo-updates (already in the store builds);
 * the web build reloads the page; in development the dev menu reload is used. Returns false when nothing could reload,
 * so the caller can say the change shows the next time the app opens.
 */
export async function reloadApp(): Promise<boolean> {
  try {
    if (Platform.OS === "web") { globalThis.location?.reload(); return true; }
    if (process.env.NODE_ENV === "test") return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const U = require("expo-updates") as { reloadAsync?: () => Promise<void>; isEnabled?: boolean };
      if (U?.reloadAsync && U.isEnabled !== false) { await U.reloadAsync(); return true; }
    } catch { /* fall through */ }
    if (__DEV__ && DevSettings?.reload) { DevSettings.reload(); return true; }
    return false;
  } catch { return false; }
}
