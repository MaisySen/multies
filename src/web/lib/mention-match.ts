/**
 * The people an "@query" in the meeting notes matches: names with a word starting with the query
 * first, then names containing it anywhere, up to a limit. An empty query lists the first few.
 */
export interface MentionPerson { type: "member" | "agent"; id: string; name: string }

export function mentionMatches<T extends MentionPerson>(people: T[], query: string, limit = 6): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return people.slice(0, limit);
  const starts = people.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q));
  const rest = people.filter((p) => !starts.includes(p) && p.name.toLowerCase().includes(q));
  return [...starts, ...rest].slice(0, limit);
}

