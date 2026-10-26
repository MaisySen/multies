/**
 * R31: the docs "/" menu, as data. The menu component (slash-menu.tsx) reads the caret's text,
 * asks slashQuery() whether a menu should be open, filters SLASH_ITEMS with filterSlash() and
 * runs the picked item's action. Pure, so it is unit tested without an editor.
 */

export type SlashGroup = "Basic" | "Lists" | "Media" | "Embeds";
export const SLASH_GROUPS: SlashGroup[] = ["Basic", "Lists", "Media", "Embeds"];

export type SlashAction =
  | { kind: "paragraph" }
  | { kind: "heading"; level: 1 | 2 | 3 }
  | { kind: "bulletList" } | { kind: "orderedList" } | { kind: "taskList" }
  | { kind: "blockquote" } | { kind: "codeBlock" } | { kind: "horizontalRule" }
  | { kind: "linkPicker" } | { kind: "date" };

export interface SlashItem { id: string; label: string; hint: string; group: SlashGroup; keywords: string[]; markdown?: string; action: SlashAction }

/** Every block the doc editor supports (StarterKit, to-do lists and the page link picker). */
export const SLASH_ITEMS: SlashItem[] = [
  { id: "text", label: "Text", hint: "Plain paragraph", group: "Basic", keywords: ["paragraph", "plain", "body"], action: { kind: "paragraph" } },
  { id: "h1", label: "Heading 1", hint: "Big section title", group: "Basic", keywords: ["title", "h1", "header"], markdown: "#", action: { kind: "heading", level: 1 } },
  { id: "h2", label: "Heading 2", hint: "Medium section title", group: "Basic", keywords: ["subtitle", "h2", "header"], markdown: "##", action: { kind: "heading", level: 2 } },
  { id: "h3", label: "Heading 3", hint: "Small section title", group: "Basic", keywords: ["h3", "header"], markdown: "###", action: { kind: "heading", level: 3 } },
  { id: "quote", label: "Quote", hint: "Call out a quote", group: "Basic", keywords: ["blockquote", "citation"], markdown: ">", action: { kind: "blockquote" } },
  { id: "code", label: "Code block", hint: "Code with spacing kept", group: "Basic", keywords: ["snippet", "pre", "monospace"], markdown: "```", action: { kind: "codeBlock" } },
  { id: "divider", label: "Divider", hint: "A line between sections", group: "Basic", keywords: ["rule", "line", "separator", "hr"], markdown: "---", action: { kind: "horizontalRule" } },
  { id: "bullets", label: "Bulleted list", hint: "A simple list", group: "Lists", keywords: ["unordered", "ul", "points"], markdown: "-", action: { kind: "bulletList" } },
  { id: "numbers", label: "Numbered list", hint: "A list in order", group: "Lists", keywords: ["ordered", "ol", "steps"], markdown: "1.", action: { kind: "orderedList" } },
  { id: "todo", label: "To-do list", hint: "Tick items off", group: "Lists", keywords: ["task", "checkbox", "checklist", "todo"], markdown: "[]", action: { kind: "taskList" } },
  { id: "link", label: "Link a page or task", hint: "Find and link it", group: "Embeds", keywords: ["mention", "page", "doc", "task", "reference", "[["], action: { kind: "linkPicker" } },
  { id: "date", label: "Today's date", hint: "Insert the date", group: "Embeds", keywords: ["date", "today", "time", "now"], action: { kind: "date" } },
];

/**
 * The query after a "/" typed at the start of a line or after a space, or null when no menu
 * should be open. `before` is the text of the current block up to the caret.
 */
export function slashQuery(before: string): string | null {
  const m = /(?:^|\s)\/([^\s/]{0,24})$/.exec(before);
  return m ? m[1] : null;
}

/** Scores how well `query` matches `text`: prefix > word start > in order letters; 0 is no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase(), t = text.toLowerCase();
  if (!q) return 1;
  if (t.startsWith(q)) return 100 - Math.min(t.length - q.length, 50) / 10;
  const words = t.split(/[\s-]+/);
  if (words.some((w) => w.startsWith(q))) return 80;
  if (t.includes(q)) return 60;
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) { if (last >= 0 && j > last + 1) gaps++; last = j; i++; }
  }
  return i === q.length ? Math.max(1, 40 - gaps * 5) : 0;
}

/** Items that match, best first; ties keep the menu's own order. */
export function filterSlash(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.trim();
  if (!q) return items;
  return items
    .map((it, i) => ({ it, i, s: Math.max(fuzzyScore(q, it.label), ...it.keywords.map((k) => fuzzyScore(q, k) * 0.9), it.markdown && it.markdown === q ? 95 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.it);
}

/**
 * Rows for display with each item's index in the flat list (for the keyboard): grouped by
 * Basic, Lists, Media, Embeds with no query, one ranked list while filtering.
 */
export function groupSlash(items: SlashItem[], filtering: boolean): { group: string; items: { item: SlashItem; index: number }[] }[] {
  const flat = items.map((item, index) => ({ item, index }));
  if (!flat.length) return [];
  if (filtering) return [{ group: "Best matches", items: flat }];
  return SLASH_GROUPS.map((group) => ({ group: group as string, items: flat.filter((x) => x.item.group === group) })).filter((g) => g.items.length);
}

/** Moves the highlighted row, wrapping at both ends. */
export function moveSel(sel: number, delta: number, count: number): number {
  if (!count) return 0;
  return (sel + delta + count) % count;
}

/** The date an item inserts, like "Mon 26 Oct 2026", in the reader's locale order. */
export function todayText(now = new Date(), locale?: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(now).replace(/,/g, "");
}
