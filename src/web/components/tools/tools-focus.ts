/**
 * F13b (MB-309): a tool view that needs the whole width (the contract interview) hides the tools rail while it is open.
 * Kept in its own module with no imports beyond React so a tool page can use it without importing the tools frame
 * (that import made a circular chunk in the production build and the interview crashed on Start).
 */
import { createContext, useContext, useEffect } from "react";

export const ToolsFocusContext = createContext<(on: boolean) => void>(() => {});

export function useToolsFocus() {
  const set = useContext(ToolsFocusContext);
  useEffect(() => {
    set(true);
    return () => set(false);
  }, [set]);
}
