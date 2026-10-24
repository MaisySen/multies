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
