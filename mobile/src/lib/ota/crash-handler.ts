/**
 * Report a JavaScript crash with the running update's tags before the app goes down. React Native's
 * global handler (ErrorUtils) is wrapped, not replaced: the original handler still runs, a little
 * later for a fatal error so the report reaches the on-device queue first (sent on the next launch
 * if the process dies before the network call ends).
 */
import type { Telemetry } from "./telemetry";

type Handler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void };

let installed = false;

export function installCrashHandler(t: Telemetry, o: { errorUtils?: ErrorUtilsLike; updateId: () => string | null; waitMs?: number } ): boolean {
  const eu = o.errorUtils ?? (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!eu || installed) return false;
  installed = true;
  const previous = eu.getGlobalHandler();
  eu.setGlobalHandler((error, isFatal) => {
    const e = error as { name?: string; message?: string; stack?: string } | undefined;
    const report = t.record({
      event: isFatal ? "crash" : "failed",
      updateId: o.updateId(),
      message: e?.message ?? String(error),
      error: { type: e?.name ?? "Error", value: String(e?.message ?? error).slice(0, 500), stack: e?.stack },
      extra: { fatal: !!isFatal },
    });
    if (!isFatal) { previous(error, isFatal); return; }
    let done = false;
    const go = () => { if (!done) { done = true; previous(error, isFatal); } };
    report.then(go, go);
    setTimeout(go, o.waitMs ?? 600);
  });
  return true;
}

/** Tests only. */
export function resetCrashHandlerForTests() { installed = false; }
