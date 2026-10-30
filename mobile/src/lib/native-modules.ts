import { Platform } from "react-native";

/**
 * R37 (store build 1.10.0, native batch 1): optional native modules. Every feature that uses one
 * of these fails soft: if the module is missing (an older binary running a newer bundle, web, or
 * tests) the loader returns null and the caller keeps the plain JS behaviour.
 */
const cache = new Map<string, unknown>();

function load<T>(name: string, get: () => T): T | null {
  if (cache.has(name)) return cache.get(name) as T | null;
  let mod: T | null = null;
  if (Platform.OS !== "web" && process.env.NODE_ENV !== "test") {
    try { mod = get() ?? null; } catch { mod = null; }
  }
  cache.set(name, mod);
  return mod;
}

/* eslint-disable @typescript-eslint/no-require-imports */
export const nativeSymbols = () => load("expo-symbols", () => require("expo-symbols") as typeof import("expo-symbols"));
export const nativeBlur = () => load("expo-blur", () => require("expo-blur") as typeof import("expo-blur"));
export const nativeLocalAuth = () => load("expo-local-authentication", () => require("expo-local-authentication") as typeof import("expo-local-authentication"));
export const nativeQuickActions = () => load("expo-quick-actions", () => require("expo-quick-actions") as typeof import("expo-quick-actions"));
export const nativeStoreReview = () => load("expo-store-review", () => require("expo-store-review") as typeof import("expo-store-review"));
export const nativeGestureHandler = () => load("react-native-gesture-handler", () => require("react-native-gesture-handler") as typeof import("react-native-gesture-handler"));
/* eslint-enable @typescript-eslint/no-require-imports */

/** For tests: forget what was loaded. */
export function resetNativeModules() { cache.clear(); }
