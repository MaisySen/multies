/** R31: catch-up digest on the web (shape of GET /api/catchup) and its one-line headline. */
export type CatchupType = "channel" | "task" | "doc";
export interface CatchupDigest {
  type: CatchupType; id: string; since: string | null; hasNew: boolean; mode: "digest";
  counts: { messages: number; replies: number; comments: number; edits: number; statusChanges: number; assigneeChanges: number; mentions: number };
  actors: { name: string; count: number }[];
  decisions: { kind: string; text: string; actor: string | null; at: string }[];
  latest: { id: string; actor: string | null; text: string; at: string }[];
  canSummarise: boolean;
}

const n = (k: number, one: string, many: string) => (k ? `${k} ${k === 1 ? one : many}` : "");

/** "3 new messages, 1 mention of you from Sam and Ana". */
export function catchupHeadline(d: CatchupDigest): string {
  const c = d.counts;
  const parts = [
    n(c.messages, "new message", "new messages"), n(c.replies, "reply", "replies"), n(c.comments, "comment", "comments"),
    n(c.statusChanges, "status change", "status changes"), n(c.assigneeChanges, "assignee change", "assignee changes"),
    n(c.edits, "edit", "edits"), n(c.mentions, "mention of you", "mentions of you"),
  ].filter(Boolean);
  if (!parts.length) return "Nothing new";
  const who = d.actors.map((a) => a.name);
  const from = who.length ? ` from ${who.length > 2 ? `${who.slice(0, 2).join(", ")} and others` : who.join(" and ")}` : "";
  return `${parts.join(", ")}${from}`;
}
