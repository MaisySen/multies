import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

/** Small secrets (the session cookie) in the iOS Keychain or Android Keystore. Web uses localStorage. */
export const secureStorage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") return globalThis.localStorage?.getItem(key) ?? null;
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") { globalThis.localStorage?.setItem(key, value); return; }
    await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === "web") { globalThis.localStorage?.removeItem(key); return; }
    await SecureStore.deleteItemAsync(key);
  },
};
