/**
 * Masks credentials in free text: log lines, error messages, test output.
 * Two layers, because a length rule alone misses short passwords (R26 lesson: a 21 character
 * password with a "!" in it slipped past a "24 or more word characters" filter):
 * 1. Shapes: bearer tokens, JWTs, provider key prefixes, and any `secret|password|token|key = value` pair,
 *    whatever the value's length or characters.
 * 2. Known values: every value handed in (for example from process.env under a secret looking name),
 *    masked wherever it appears, 6 characters or longer.
 */
export const SECRET_NAME = /pass(word)?|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|dsn|cvc/i;

const SHAPES: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(re|sk|rk|pk|whsec|ghp|gho|ghs|github_pat|xox[abpr])_[A-Za-z0-9_]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** `client_secret=...`, `"password": "..."`, `AUTH0_MGMT_CLIENT_SECRET (new)=...`: masks the value, keeps the name. */
const PAIR = /([A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key|authorization|cookie)[A-Za-z0-9_.-]*(?:\s*\([^)\n]{0,40}\))?["']?\s*[:=]\s*["'`]?)([^\s"'`,;&}]+)/gi;

export const MASK = "[masked]";

export function maskSecretText(text: string, known: Iterable<string> = []): string {
  let out = text;
  const values = [...new Set([...known].filter((v) => typeof v === "string" && v.length >= 6))].sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join(MASK);
  for (const re of SHAPES) out = out.replace(re, (m) => (m.startsWith("Bearer") || m.startsWith("Basic") || /^bearer|^basic/i.test(m) ? `${m.split(/\s+/)[0]} ${MASK}` : MASK));
  out = out.replace(PAIR, (_m, name: string, value: string) => (value === MASK ? `${name}${value}` : `${name}${MASK}`));
  return out;
}

/** Values of environment entries whose name looks like a credential (for masking test and script output). */
export function secretValuesFromEnv(env: Record<string, string | undefined>): string[] {
  return Object.entries(env).filter(([k, v]) => SECRET_NAME.test(k) && typeof v === "string" && v.length >= 6).map(([, v]) => v as string);
}
