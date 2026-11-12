/**
 * K1 status import mapping: which board column an imported status lands in when the person has not chosen one.
 * Before this, a file status whose name was not exactly a column's name ("Complete" on a board with "Done",
 * "In Progress" beside "Doing", "Closed", "Backlog" and so on) was always added as a new column, so every import
 * from another tool grew the board by a second done column. Now a name that means the same as an existing
 * column lands in it; anything else is still added as new, and the person can change each choice in the import.
 */

type Category = "todo" | "doing" | "done";

/** Lower case, letters and digits only: "In-Progress", "in progress" and "InProgress" are one name. */
export const statusKey = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

/** Names that mean the same column, by meaning; the first group a name belongs to wins. */
const SAME: readonly (readonly string[])[] = [
  ["done", "complete", "completed", "closed", "resolved", "finished", "shipped", "released", "fixed", "delivered"],
  ["inprogress", "doing", "wip", "workinprogress", "started", "active", "ongoing", "underway"],
  ["inreview", "review", "codereview", "reviewing", "awaitingreview", "readyforreview"],
  ["todo", "tobedone", "open", "new", "notstarted", "unstarted", "ready", "selectedfordevelopment", "planned"],
  ["blocked", "onhold", "waiting", "paused", "stuck"],
  ["backlog", "icebox", "someday", "ideas"],
  ["cancelled", "canceled", "wontdo", "wontfix", "dropped", "abandoned"],
];
const groupOf = (key: string) => SAME.findIndex((g) => g.includes(key));

export type BoardStatus = { id: string; name: string; category: Category; position: number };

/**
 * The column a file status maps to by default: a column with the same name (any case, spaces or dashes), else the
 * first column (board order) whose name means the same, else null (add it as a new column).
 */
export function suggestColumn(fileStatus: string, columns: readonly BoardStatus[], category?: Category): BoardStatus | null {
  const key = statusKey(fileStatus);
  if (!key) return null;
  // A column in another group (a file's done status and a to do column) is never a match, even by name.
  const ordered = [...columns].filter((c) => !category || c.category === category).sort((a, b) => a.position - b.position);
  const same = ordered.find((c) => statusKey(c.name) === key);
  if (same) return same;
  const g = groupOf(key);
  if (g < 0) return null;
  return ordered.find((c) => groupOf(statusKey(c.name)) === g) ?? null;
}

/**
 * The default mapping for a whole file: file status name (lower case, as the import's statusMap keys it) to a
 * column id, for every status that has a sensible column. Names the person chose already (keys of `chosen`, a
 * null meaning "add as new") are left as they chose.
 */
export function suggestStatusMap(fileStatuses: readonly { name: string; category?: Category }[], columns: readonly BoardStatus[], chosen: Readonly<Record<string, string | null>> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, category } of fileStatuses) {
    const k = name.trim().toLowerCase();
    if (!k || k in chosen) continue;
    const c = suggestColumn(name, columns, category);
    if (c) out[k] = c.id;
  }
  return out;
}
