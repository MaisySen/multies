/**
 * Cloudflare D1 refuses queries once an account passes its daily row limits (Free plan: 100,000 rows
 * written and 5 million read per day, reset at 00:00 UTC). Those errors are expected, not bugs: the
 * API answers with a calm read only message and they are not sent to error tracking.
 */
const LIMIT_PATTERN = /(exceeded|over|reached)[^.]{0,60}(daily|per day|limit|quota)|daily (read|write|row)s? limit|rows (written|read) limit/i;

export function isD1LimitError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const message = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    if (LIMIT_PATTERN.test(message)) return true;
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}

export const READ_ONLY_BODY = {
  error: { code: "read_only", message: "Multies is read only for a short while. Your data is safe. Please try again soon." },
};
