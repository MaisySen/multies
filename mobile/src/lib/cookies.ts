/**
 * A tiny cookie jar. React Native's fetch doesn't share cookies the way a browser does, so the
 * app keeps the Better Auth cookies itself and sends them as a Cookie header.
 */
export type Jar = Record<string, string>;

/** Splits a combined Set-Cookie header. Commas inside Expires dates are not separators. */
export function splitSetCookie(header: string): string[] {
  return header.split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map((s) => s.trim()).filter(Boolean);
}

export function applySetCookie(jar: Jar, header: string | null | undefined): Jar {
  if (!header) return jar;
  const next = { ...jar };
  for (const cookie of splitSetCookie(header)) {
    const [pair, ...attrs] = cookie.split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((a) => {
      const [k, v = ""] = a.split("=");
      const key = k.trim().toLowerCase();
      if (key === "max-age") return Number(v) <= 0;
      if (key === "expires") { const t = Date.parse(v.trim()); return !Number.isNaN(t) && t < Date.now(); }
      return false;
    });
    if (expired || value === "") delete next[name];
    else next[name] = value;
  }
  return next;
}

export function cookieHeader(jar: Jar): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

export function hasSession(jar: Jar): boolean {
  return Object.keys(jar).some((k) => k.endsWith("session_token"));
}
