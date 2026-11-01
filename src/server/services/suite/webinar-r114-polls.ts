/**
 * R114: the meeting's R96 polls as a webinar shows them (choice polls and word clouds; decisions stay with members).
 * Names are never shown to attendees; hosts see counts too.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { chatPollVotes, chatPolls, meetings } from "../../db/schema";
import { inIds } from "../../lib/sql-chunks";
import { isOpenPoll, tallyCloud } from "../../../shared/chat-plus";

export type WebinarPoll = { id: string; kind: "poll" | "cloud"; question: string; options: string[]; multi: boolean; open: boolean; total: number; results: { label: string; count: number }[] };

export async function listPolls(deps: Deps, m: Pick<typeof meetings.$inferSelect, "id" | "orgId">, _viewer: string | null, _host: boolean): Promise<WebinarPoll[]> {
  const rows = (await deps.db.select().from(chatPolls).where(and(eq(chatPolls.orgId, m.orgId), eq(chatPolls.meetingId, m.id))).orderBy(desc(chatPolls.createdAt)).limit(20))
    .filter((p) => p.kind === "poll" || p.kind === "cloud");
  if (!rows.length) return [];
  const votes = await deps.db.select({ pollId: chatPollVotes.pollId, voter: chatPollVotes.voter, choice: chatPollVotes.choice }).from(chatPollVotes).where(inIds(chatPollVotes.pollId, rows.map((p) => p.id))).limit(20_000);
  const now = deps.now();
  return rows.map((p) => {
    const vs = votes.filter((v) => v.pollId === p.id);
    const options = JSON.parse(p.options) as string[];
    const results = p.kind === "poll"
      ? options.map((label, i) => ({ label, count: vs.filter((v) => v.choice === String(i)).length }))
      : tallyCloud(vs.map((v) => v.choice), 20).map((w) => ({ label: w.word, count: w.count }));
    return { id: p.id, kind: p.kind as "poll" | "cloud", question: p.question, options, multi: p.multi, open: isOpenPoll(p, now), total: new Set(vs.map((v) => v.voter)).size, results };
  });
}

export async function myVotes(deps: Deps, pollIds: string[], voter: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!pollIds.length) return out;
  const rows = await deps.db.select({ pollId: chatPollVotes.pollId, choice: chatPollVotes.choice }).from(chatPollVotes).where(and(inIds(chatPollVotes.pollId, pollIds), eq(chatPollVotes.voter, voter))).limit(500);
  for (const r of rows) out.set(r.pollId, [...(out.get(r.pollId) ?? []), r.choice]);
  return out;
}

