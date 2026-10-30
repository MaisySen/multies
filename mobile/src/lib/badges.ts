import { Platform } from "react-native";
import type { Task } from "@/api/types";
import { dayFrom } from "./tasks";

/**
 * R33: badge counts from the lists the app already loads (a dedicated count endpoint is R34).
 * Tasks: open tasks assigned to me that are due today or overdue. App icon: unread mail, unread
 * Activity, unread chat and approvals waiting, added up.
 */
export function taskBadgeCount(tasks: readonly Task[] | undefined, now = new Date()): number {
  if (!tasks) return 0;
  const today = dayFrom(0, now);
  return tasks.filter((t) => t.status !== "done" && !!t.due && t.due.slice(0, 10) <= today).length;
}

export function appBadgeTotal(parts: { inbox?: number; activity?: number; chat?: number; approvals?: number }): number {
  return Math.max(0, (parts.inbox ?? 0) + (parts.activity ?? 0) + (parts.chat ?? 0) + (parts.approvals ?? 0));
}

let last = -1;
/** Sets the number on the app icon (no prompt; iOS shows it only when notifications are allowed). */
export function setAppBadge(n: number) {
  if (Platform.OS === "web" || n === last) return;
  last = n;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const N = require("expo-notifications") as typeof import("expo-notifications");
  N.setBadgeCountAsync?.(n)?.catch?.(() => {});
}
