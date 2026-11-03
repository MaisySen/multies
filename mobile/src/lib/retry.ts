/**
 * When a failed request is worth asking again. Network blips and server errors get two more tries; a sign in problem
 * (401) or any other answer the server gave on purpose (400 to 499, except timeouts and rate limits) does not, so a
 * missing message shows its "Couldn't open" state at once instead of a loading list for several seconds (M5).
 */
export function shouldRetry(failures: number, err: unknown): boolean {
  if (failures >= 2) return false;
  const status = (err as { status?: number } | null)?.status;
  if (typeof status !== "number" || status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
}
