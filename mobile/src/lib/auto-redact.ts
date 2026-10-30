/**
 * Auto redact ("Hide sensitive info", feature autoredact) on the phone: the same two steps as the web. pii-find
 * lists what it found, the person unticks what should stay, and the redact tool blacks out the rest (it checks
 * afterwards that none can be found). Nothing is blacked out without that review.
 */
export const PII_KINDS = [
  { kind: "tfn", label: "Tax file numbers" },
  { kind: "abn", label: "ABNs" },
  { kind: "acn", label: "ACNs" },
  { kind: "bsb_account", label: "Bank details (BSB and account)" },
  { kind: "card", label: "Card numbers" },
  { kind: "medicare", label: "Medicare numbers" },
  { kind: "phone", label: "Phone numbers" },
  { kind: "email", label: "Email addresses" },
] as const;

export interface PiiMatch { kind: string; text: string; page: number }
const LABEL: Record<string, string> = Object.fromEntries(PII_KINDS.map((k) => [k.kind, k.label]));

/** Reads pii-find's JSON: {"matches":[{"kind","text","page"}]}. Bad rows are dropped. */
export function parseMatches(raw: string): PiiMatch[] {
  try {
    const v = JSON.parse(raw) as { matches?: unknown };
    if (!Array.isArray(v.matches)) return [];
    return v.matches.filter((m): m is PiiMatch => !!m && typeof (m as PiiMatch).text === "string" && (m as PiiMatch).text.trim() !== "" && typeof (m as PiiMatch).kind === "string")
      .map((m) => ({ kind: m.kind, text: m.text.trim().slice(0, 200), page: Number(m.page) || 0 }));
  } catch { return []; }
}

/** Matches grouped by kind (tax numbers first); the same text on the same page counted once. */
export function groupMatches(matches: PiiMatch[]): { kind: string; label: string; items: (PiiMatch & { key: string })[] }[] {
  const order = [...PII_KINDS.map((k) => k.kind as string), ...new Set(matches.map((m) => m.kind))];
  const seen = new Set<string>();
  const out: { kind: string; label: string; items: (PiiMatch & { key: string })[] }[] = [];
  for (const kind of [...new Set(order)]) {
    const items = matches.filter((m) => m.kind === kind).map((m) => ({ ...m, key: `${m.kind}|${m.text}|${m.page}` })).filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true)));
    if (items.length) out.push({ kind, label: LABEL[kind] ?? "Other", items });
  }
  return out;
}

/** The phrases to black out: each ticked text once, one per line, within the redact tool's 2,000 characters. */
export function phrasesFor(matches: PiiMatch[], ticked: Set<string>, max = 2000): string {
  const texts = new Set<string>();
  for (const m of matches) if (ticked.has(`${m.kind}|${m.text}|${m.page}`)) texts.add(m.text);
  let out = "";
  for (const t of texts) { const next = out ? `${out}\n${t}` : t; if (next.length > max) break; out = next; }
  return out;
}
