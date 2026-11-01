/**
 * R96: chat plus. Pure rules for topics, decision votes, polls, live Q&A and word clouds, shared by the
 * server, the web app and the tests.
 */
export const DECISION_STANCES = ["agree", "abstain", "disagree", "block"] as const;
export type Stance = (typeof DECISION_STANCES)[number];
export const STANCE_LABEL: Record<Stance, string> = { agree: "Agree", abstain: "Abstain", disagree: "Disagree", block: "Block" };
export const POLL_KINDS = ["poll", "decision", "qa", "cloud"] as const;
export type PollKind = (typeof POLL_KINDS)[number];
export const POLL_KIND_LABEL: Record<PollKind, string> = { poll: "Poll", decision: "Decision", qa: "Questions", cloud: "Word cloud" };

export const CHAT_PLUS_LIMITS = {
  question: 300, option: 120, minOptions: 2, maxOptions: 10, words: 3, word: 24, item: 280, items: 200, reason: 500, topic: 60, topicsPerChannel: 200,
  maxDays: 90, decisionDefaultHours: 48,
} as const;

/** A topic name as shown: trimmed, single spaces, no leading tick (the tick is the resolved mark, not part of the name). */
export function cleanTopicName(name: string): string {
  return name.replace(/\s+/g, " ").trim().replace(/^(?:✓|✔)\s*/, "").slice(0, CHAT_PLUS_LIMITS.topic).trim();
}
/** Two topic names that differ only in case or spacing are the same topic. */
export function topicKey(name: string): string {
  return cleanTopicName(name).toLowerCase();
}

/** Poll choices: trimmed, empty ones dropped, case insensitive duplicates dropped. Returns an error message when the set is not usable. */
export function cleanOptions(raw: string[]): { options: string[] } | { error: string } {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const r of raw) {
    const o = r.replace(/\s+/g, " ").trim().slice(0, CHAT_PLUS_LIMITS.option);
    if (!o || seen.has(o.toLowerCase())) continue;
    seen.add(o.toLowerCase());
    options.push(o);
  }
  if (options.length < CHAT_PLUS_LIMITS.minOptions) return { error: "Add at least two different choices." };
  if (options.length > CHAT_PLUS_LIMITS.maxOptions) return { error: `A poll can have up to ${CHAT_PLUS_LIMITS.maxOptions} choices.` };
  return { options };
}

/** A word cloud entry: lower case letters and numbers (any script), inner apostrophes kept, at most 24 characters. */
export function normaliseWord(w: string): string {
  return w.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, CHAT_PLUS_LIMITS.word).trim();
}
/** Up to three distinct words from what someone typed (split on commas or new lines; a phrase stays one entry). */
export function cloudWords(raw: string[]): string[] {
  const out: string[] = [];
  for (const part of raw.flatMap((r) => r.split(/[,\n]/))) {
    const w = normaliseWord(part);
    if (w && !out.includes(w)) out.push(w);
    if (out.length === CHAT_PLUS_LIMITS.words) break;
  }
  return out;
}

export function tallyCloud(words: string[], top = 40): { word: string; count: number }[] {
  const m = new Map<string, number>();
  for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
  return [...m.entries()].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, top);
}

export type DecisionResult = "passed" | "not_passed" | "blocked" | "no_votes";
export const DECISION_RESULT_LABEL: Record<DecisionResult, string> = { passed: "Agreed", not_passed: "Not agreed", blocked: "Blocked", no_votes: "No votes" };

/** The outcome of a decision: any block stops it; otherwise it passes when more people agree than disagree. Abstain counts as taking part only. */
export function decisionOutcome(counts: Partial<Record<Stance, number>>): { result: DecisionResult; summary: string } {
  const n = (s: Stance) => counts[s] ?? 0;
  const total = DECISION_STANCES.reduce((t, s) => t + n(s), 0);
  const parts = `${n("agree")} agree, ${n("abstain")} abstain, ${n("disagree")} disagree, ${n("block")} block`;
  if (!total) return { result: "no_votes", summary: "No one voted." };
  if (n("block") > 0) return { result: "blocked", summary: `Blocked (${parts}).` };
  if (n("agree") > n("disagree")) return { result: "passed", summary: `Agreed (${parts}).` };
  return { result: "not_passed", summary: `Not agreed (${parts}).` };
}

/** The winning choices of a poll (all ties), or none when no one voted. */
export function pollWinners(options: string[], counts: number[]): string[] {
  const max = Math.max(0, ...counts);
  if (!max) return [];
  return options.filter((_, i) => counts[i] === max);
}

export function isOpenPoll(p: { closedAt: Date | string | null; closesAt: Date | string | null }, now: Date): boolean {
  if (p.closedAt) return false;
  return !p.closesAt || new Date(p.closesAt).getTime() > now.getTime();
}

/** The line a card message carries in previews, notifications and search. */
export function pollMessageBody(kind: PollKind, question: string): string {
  return `${POLL_KIND_LABEL[kind]}: ${question}`;
}
