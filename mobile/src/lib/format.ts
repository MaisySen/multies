/** Dates and sizes for an Australian audience: en-AU formats, the device's own time zone. */
export const LOCALE = "en-AU";

export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return d.toLocaleDateString(LOCALE, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function timeLeft(iso: string, now = Date.now()): string {
  const h = Math.round((new Date(iso).getTime() - now) / 3_600_000);
  if (h <= 0) return "expires soon";
  return h < 48 ? `expires in ${h} h` : `expires in ${Math.round(h / 24)} days`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") && !nameOrEmail.includes(" ") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function displayName(a: { address: string; name?: string | null }): string {
  return a.name?.trim() || a.address;
}

/** Turns "a@b.com, c@d.com" or newline lists into clean addresses. */
export function parseRecipients(input: string): string[] {
  return input.split(/[\s,;]+/).map((s) => s.trim().replace(/^<|>$/g, "")).filter(Boolean);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function quoteForReply(text: string, from: string, iso: string): string {
  const when = new Date(iso).toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  return `\n\nOn ${when}, ${from} wrote:\n${text.split("\n").map((l) => `> ${l}`).join("\n")}`;
}
