import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

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
