import { AccessibilityInfo, Platform } from "react-native";
import * as Haptics from "expo-haptics";
import { getPrefs, loadPrefs } from "./prefs";

/**
 * R33: the haptic map, one place for every cue (expo-haptics is already in the app).
 * - tick: a swipe crosses its line, a choice changes
 * - success: a task or mail action lands
 * - warning: something failed
 * - thud: a long press opens a menu
 * Nothing plays on the web, with Reduce Motion on, or with Settings, Haptics off.
 */
export type HapticKind = "tick" | "success" | "warning" | "thud";

let reduceMotion = false;
AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { reduceMotion = v; }).catch(() => {});
AccessibilityInfo.addEventListener?.("reduceMotionChanged", (v: boolean) => { reduceMotion = v; });
void loadPrefs().catch(() => {});

/** Whether a cue should play now. Exported for tests. */
export function hapticsAllowed(opts: { platform?: string; reduce?: boolean; enabled?: boolean } = {}): boolean {
  const platform = opts.platform ?? Platform.OS;
  const reduce = opts.reduce ?? reduceMotion;
  const enabled = opts.enabled ?? getPrefs().haptics;
  return platform !== "web" && !reduce && enabled;
}

export function haptic(kind: HapticKind) {
  if (!hapticsAllowed()) return;
  const p = kind === "tick" ? Haptics.selectionAsync?.()
    : kind === "thud" ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    : Haptics.notificationAsync(kind === "success" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
  p?.catch?.(() => {});
}

export const tick = () => haptic("tick");
export const thud = () => haptic("thud");
export const success = () => haptic("success");
export const warning = () => haptic("warning");
