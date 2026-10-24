import { runWithRequestState } from "@better-auth/core/context";

/**
 * Runs one request inside its own Better Auth request state. Better Auth opens this
 * AsyncLocalStorage store lazily inside each auth call when none exists, and on Workers
 * that lost the store under concurrent requests in one isolate, so getSession threw
 * "No request state found" and the API answered 500 failed_to_get_session. Every entry
 * (Worker, Node) opens the store once per request instead.
 */
export async function withAuthRequestState<T>(fn: () => Promise<T>): Promise<T> {
  return (await runWithRequestState(new WeakMap(), fn)) as T;
}

/**
 * True for the rare getSession failure where Workers still lost the request state inside
 * Better Auth (about 1 in 300 requests under concurrent load even with the store opened per
 * request). The caller retries once in a fresh store.
 */
export function isLostRequestState(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: string | number; body?: { code?: string }; cause?: unknown; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  const cause = e.cause as { message?: string } | undefined;
  if (cause?.message?.includes("No request state found")) return true;
  if (e.message?.includes("No request state found")) return true;
  return e.body?.code === "FAILED_TO_GET_SESSION" && (e.statusCode === 500 || e.status === "INTERNAL_SERVER_ERROR");
}
