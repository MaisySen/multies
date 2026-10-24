import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "expo-router";

/** True while the app is on screen (not in the background). */
export function useForeground(): boolean {
  const [active, setActive] = useState(AppState.currentState !== "background" && AppState.currentState !== "inactive");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  return active;
}

/** A polling interval for react-query that only runs while this screen is focused and the app is in the foreground. */
export function usePollWhileVisible(ms: number): number | false {
  const focused = useIsFocused();
  const foreground = useForeground();
  return focused && foreground ? ms : false;
}
