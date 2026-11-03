import { Platform } from "react-native";
import type { Counts } from "./counts";

/**
 * M5: screenshot fixtures for the web build only (never on phones). The shot harness sets
 * localStorage "m5-shots" to JSON like {"counts":{...},"name":"..."} to render real world
 * extremes (15,527 unread, zero counts, long names) on the sample workspace.
 */
export interface ShotFixture { counts?: Counts; name?: string; approvals?: number }

export function shotFixture(): ShotFixture | null {
  if (Platform.OS !== "web") return null;
  try {
    const raw = (globalThis as { localStorage?: Storage }).localStorage?.getItem("m5-shots");
    return raw ? (JSON.parse(raw) as ShotFixture) : null;
  } catch {
    return null;
  }
}
