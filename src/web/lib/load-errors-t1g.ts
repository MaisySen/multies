/**
 * T1G (T1-8): a page whose reads fail must say so instead of showing loading skeletons forever.
 *
 * - queryRetry: api.get already tries a dropped request or an empty 5xx three times, so the query retries such a
 *   failure once more (it used to retry twice, which kept a page on skeletons for about ten seconds before any
 *   message could show). A 4xx is never retried; any other failure is retried twice as before.
 * - failedLoads: the reads on screen that failed because the server failed or did not answer, and that have nothing
 *   to show. A read that failed after it had loaded keeps its data on screen and is not counted.
 * - a small store of what is on screen: loading skeletons and inline load errors. The app frame shows its one
 *   "Couldn't load this" strip only while a failed read leaves a skeleton up and no inline error is already showing.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Query, QueryClient } from "@tanstack/react-query";
import { ApiError, isTransientError } from "./api";

export const LOAD_ERROR_TITLE = "Couldn't load this";
// F12 (MB-299): the one wording for a failed load, on every page, panel and the app frame strip.
export const LOAD_ERROR_BODY = "Something went wrong on our side. Your work is safe.";

/** Reads the app frame already explains in its own way (the account check has the Reconnecting pill). */
const OWN_STATE_KEYS = new Set(["me", "session"]);

/** True when a read failed because Multies failed or did not answer, not because the request was refused (4xx). */
export function isServerLoadError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.code === "read_only") return false; // has its own banner
    return err.status === 0 || err.status >= 500 || isTransientError(err);
  }
  return err instanceof TypeError;
}

/** The app wide retry rule for reads (see the note at the top). */
export function queryRetry(count: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
  return count < (isTransientError(err) ? 1 : 2);
}

/** A read on screen that failed on the server side and has no data to show. */
export function isFailedLoad(q: Pick<Query, "queryKey" | "state" | "getObserversCount">): boolean {
  if (q.state.status !== "error" || q.state.data !== undefined || q.getObserversCount() < 1) return false;
  const head = q.queryKey[0];
  if (typeof head === "string" && OWN_STATE_KEYS.has(head)) return false;
  return isServerLoadError(q.state.error);
}

export function failedLoads(qc: QueryClient): Query[] {
  return qc.getQueryCache().getAll().filter((q) => isFailedLoad(q as Query));
}

/** Retry every failed read on screen. Reads that wait on one of them start by themselves once it answers. */
export async function retryFailedLoads(qc: QueryClient): Promise<void> {
  await qc.refetchQueries({ predicate: (q) => isFailedLoad(q as Query) });
}

// What is on screen: loading skeletons and inline load errors (counted, so the frame's strip can stay out of the way).
type Counts = { skeletons: number; inline: number };
let counts: Counts = { skeletons: 0, inline: 0 };
const listeners = new Set<() => void>();
let queued = false;
function emit() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; listeners.forEach((l) => l()); });
}
function bump(field: keyof Counts, by: number) { counts = { ...counts, [field]: Math.max(0, counts[field] + by) }; emit(); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
const getCounts = () => counts;

export function onScreenCounts(): Counts { return counts; }
export function resetOnScreenForTests() { counts = { skeletons: 0, inline: 0 }; }

/** Called by every loading skeleton while it is on screen. */
export function useMarkSkeleton() {
  useEffect(() => { bump("skeletons", 1); return () => bump("skeletons", -1); }, []);
}
/** Called by an inline load error while it is on screen. */
export function useMarkInlineLoadError() {
  useEffect(() => { bump("inline", 1); return () => bump("inline", -1); }, []);
}
export function useOnScreenCounts(): Counts {
  return useSyncExternalStore(subscribe, getCounts, getCounts);
}

/** Whether any read on screen failed on the server side with nothing to show; follows the query cache. */
export function useHasFailedLoads(qc: QueryClient): boolean {
  const [failed, setFailed] = useState(() => failedLoads(qc).length > 0);
  useEffect(() => {
    let raf = 0;
    const check = () => { raf = 0; setFailed(failedLoads(qc).length > 0); };
    const schedule = () => { if (!raf) raf = (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: () => void) => setTimeout(f, 16) as unknown as number)(check); };
    check();
    const off = qc.getQueryCache().subscribe(schedule);
    return () => { off(); };
  }, [qc]);
  return failed;
}

/** The decision the app frame makes, kept pure for tests. */
export function showLoadStrip(s: { online: boolean; failed: boolean; skeletons: number; inline: number }): boolean {
  return s.online && s.failed && s.skeletons > 0 && s.inline === 0;
}
