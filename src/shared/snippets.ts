/**
 * Round 22 (R22.4b): saved replies (snippets). The variables a saved reply can use and the pure
 * renderer, shared by the server (render routes, MCP) and the web app (live preview).
 */

export const SNIPPET_VARIABLES = ["first_name", "name", "email", "my_name", "my_first_name", "company", "mailbox", "date"] as const;
export type SnippetVariable = (typeof SNIPPET_VARIABLES)[number];
export type SnippetVars = Partial<Record<SnippetVariable, string | null | undefined>>;

export const SNIPPET_NAME_MAX = 80;
export const SNIPPET_BODY_MAX = 10_000;
export const SNIPPET_SUBJECT_MAX = 300;
export const SNIPPET_SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const SNIPPET_VARIABLE_HELP: Record<SnippetVariable, string> = {
  first_name: "Recipient's first name",
  name: "Recipient's full name",
  email: "Recipient's email address",
  my_name: "Your name",
  my_first_name: "Your first name",
  company: "Workspace name",
  mailbox: "The address you send from",
  date: "Today, e.g. 26 October 2026",
};

const KNOWN = new Set<string>(SNIPPET_VARIABLES);
const VAR_RE = /\{\{\s*([A-Za-z_]+)\s*\}\}/g;

/**
 * Fills {{variables}}. Names are case and whitespace tolerant ({{ First_Name }}). A known variable
 * with no value becomes empty, never "undefined"; an unknown one stays exactly as typed.
 */
export function renderSnippet(body: string, vars: SnippetVars): string {
  return (body ?? "").replace(VAR_RE, (whole, raw: string) => {
    const key = raw.toLowerCase();
    if (!KNOWN.has(key)) return whole;
    const v = vars[key as SnippetVariable];
    return typeof v === "string" ? v : "";
  });
}

/** The first word of a name ("Grace Hopper" gives "Grace"). */
export const firstNameOf = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] ?? "";

/** "26 October 2026" in the given IANA zone; falls back to UTC on a bad zone. */
export function snippetDate(now: Date, timeZone?: string | null): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(now);
  try { return fmt(timeZone || "UTC"); } catch { return fmt("UTC"); }
}

/** Parses the first address of a To field: "Grace Hopper <grace@example.com>, ..." or "grace@example.com". */
export function firstRecipient(to: string | null | undefined): { name: string; email: string } | null {
  const first = (to ?? "").split(/[,;]/).map((s) => s.trim()).find(Boolean);
  if (!first) return null;
  const m = first.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "", email: first };
}
