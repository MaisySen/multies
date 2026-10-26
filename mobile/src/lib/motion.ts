import { useEffect, useState } from "react";
import { AccessibilityInfo, LayoutAnimation, Platform } from "react-native";
import { motion } from "@/theme";

/** True when the person has turned on Reduce Motion (iOS) or Remove animations (Android). */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { if (live) setReduce(v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReduce);
    return () => { live = false; sub?.remove(); };
  }, []);
  return reduce;
}

/**
 * R35: one place for motion. SPRING is the spring every sheet, swipe and card uses (the same values
 * as theme.motion.spring); LIST is the list insert and delete fade. animateList() runs before a
 * state change that adds or removes rows, so the rows ease in or out instead of jumping. It does
 * nothing with Reduce Motion on or on the web.
 */

export const SPRING = motion.spring;
export const LIST = { duration: motion.base, type: "easeInEaseOut" as const, property: "opacity" as const };

let reduceNow = false;
AccessibilityInfo.isReduceMotionEnabled?.().then((v) => { reduceNow = v; }).catch(() => {});
AccessibilityInfo.addEventListener?.("reduceMotionChanged", (v: boolean) => { reduceNow = v; });

/** Whether list motion should play. Exported for tests. */
export function listMotionAllowed(opts: { platform?: string; reduce?: boolean } = {}): boolean {
  return (opts.platform ?? Platform.OS) !== "web" && !(opts.reduce ?? reduceNow);
}

export function animateList() {
  if (!listMotionAllowed()) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(LIST.duration, LIST.type, LIST.property));
}
