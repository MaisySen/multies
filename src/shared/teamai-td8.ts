/**
 * TD8 Team AI (flag TEAMAI_TD8): the shared rules for workspace AI memory, saved instruction sets, routines and the
 * assistant in chat channels. Pure functions only (server and web); the server enforces every limit here.
 */

export const TEAMAI_CAPS = {
  memoryMax: 200,
  memoryChars: 500,
  instructionsPerPerson: 50,
  instructionsPerWorkspace: 200,
  nameChars: 80,
  bodyChars: 4_000,
  routinesMax: 20,
  runsPerDay: 100,
  runsPerPass: 10,
  answerTokens: 600,
  callTimeoutMs: 25_000,
  /**
   * AIS1 (audit row 15): the run log is kept for a year (it was 30 days). The audit log itself is kept for the life of
   * the workspace, but a run row holds the answer or draft text (up to draftChars) and a workspace may make runsPerDay
   * runs, so keeping runs forever would grow without limit on the free plan's database. A year bounds it at
   * runsPerDay x 365 rows a workspace. Change it here; the prune in services/teamai-td8.ts and the page read it.
   */
  keepRunsDays: 365,
  questionChars: 1_000,
  draftChars: 8_000,
  audienceMax: 50,
  sourcesMax: 6,
} as const;

export const ROUTINE_TRIGGERS = ["daily", "weekly", "task_created", "form_response"] as const;
export type RoutineTrigger = (typeof ROUTINE_TRIGGERS)[number];
export const ROUTINE_OUTPUTS = ["draft", "chat"] as const;
export type RoutineOutput = (typeof ROUTINE_OUTPUTS)[number];
export const RUN_STATUSES = ["queued", "running", "done", "skipped", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** AIS1: the statuses a run ends in, which the year's prune may delete. Every status but queued and running. */
export const FINISHED_RUN_STATUSES: readonly RunStatus[] = RUN_STATUSES.filter((s) => s !== "queued" && s !== "running");
export type RunKind = "routine" | "mention" | "try";

export const TRIGGER_LABEL: Record<RoutineTrigger, string> = {
  daily: "Every day",
  weekly: "Every week",
  task_created: "When a task is created",
  form_response: "When a form gets a response",
};
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Why a run did not finish, in words people read in the run log. */
export const REASON_TEXT: Record<string, string> = {
  ai_off: "AI is off for this workspace",
  no_key: "No AI key is connected",
  free_limit: "Free AI limit for this workspace reached. Add your own AI key in Settings for unlimited use",
  ai_unavailable: "Built in AI is not available right now. Try again later or add your own AI key",
  too_big: "Too much text for one free AI request",
  cap: "Daily limit reached",
  provider_error: "The AI provider did not answer",
  timeout: "The AI provider took too long",
  instruction_gone: "The instruction set was deleted",
  channel_gone: "The channel is gone or archived",
  owner_gone: "The person who made the routine left the workspace",
  item_gone: "The item it was about is gone",
  empty: "The AI gave an empty answer",
};

export interface MemoryEntry {
  id: string; text: string; status: "active" | "suggested";
  createdBy: string | null; createdByName: string; createdAt: string;
  updatedBy: string | null; updatedByName: string; updatedAt: string;
  mine: boolean;
}
export interface InstructionSet {
  id: string; name: string; body: string; shared: boolean; ownerId: string; ownerName: string; mine: boolean; canEdit: boolean; updatedAt: string;
}
export interface Routine {
  id: string; name: string; instructionId: string; instructionName: string | null; trigger: RoutineTrigger; hour: number; weekday: number;
  formId: string | null; projectId: string | null; output: RoutineOutput; channelId: string | null; channelName: string | null;
  enabled: boolean; createdByName: string; nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null;
}
export interface RunEntry {
  id: string; kind: RunKind; label: string; status: RunStatus; reason: string | null; reasonText: string | null;
  output: "draft" | "chat" | "none"; result: string | null; channelId: string | null; messageId: string | null;
  actorName: string; createdAt: string; finishedAt: string | null; mine: boolean;
}
export interface TeamAiState {
  isAdmin: boolean;
  /** source: own_key = the workspace's key (no daily free limit); built_in = free built in AI under the daily limit; none = nothing can run. */
  ai: { on: boolean; key: boolean; provider: string | null; source: "own_key" | "built_in" | "none"; freeUsed: number; freeLimit: number; freePeriod: "day" | "week" };
  usedToday: number;
  /** POL2 (HQ MB-329): the workspace time zone routines run in (an IANA name, UTC when unset). */
  zone?: string;
  caps: { runsPerDay: number; routinesMax: number; memoryMax: number };
  channels: { id: string; name: string; private: boolean }[];
  forms: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

/** One line of text: trims, folds runs of spaces and drops control characters (keeps new lines when asked). */
export function cleanText(raw: unknown, max: number, keepLines = false): string {
  const s = [...String(raw ?? "").replace(/\r\n?/g, "\n")].filter((ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || (c >= 32 && c !== 127); }).join("");
  const out = keepLines ? s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim() : s.replace(/\s+/g, " ").trim();
  return out.slice(0, max);
}

const MENTION = /(^|[\s(])@assistant\b[:,]?/i;
/** True when a chat message asks the assistant (the plain text "@assistant", not inside code). */
export function mentionsAssistant(body: string): boolean {
  const text = String(body ?? "").replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  return MENTION.test(text);
}
/** The question with "@assistant" taken out. */
export function questionOf(body: string): string {
  return cleanText(String(body ?? "").replace(/<@(member|agent):[A-Za-z0-9_-]{1,64}>/g, " ").replace(new RegExp(MENTION.source, "gi"), " "), TEAMAI_CAPS.questionChars);
}

/** The offset of a time zone from UTC at an instant, in ms (positive east of UTC). */
export function zoneOffsetMs(at: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(at))) if (x.type !== "literal") p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour === 24 ? 0 : p.hour, p.minute, p.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

function validZone(tz: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
}

/** The local calendar day of an instant in a zone, as [year, month (1 to 12), day, weekday (0 Sunday)]. */
function localDay(at: number, tz: string): [number, number, number, number] {
  const d = new Date(at + zoneOffsetMs(at, tz));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay()];
}

/** The UTC instant of a local wall time in a zone (the first match when clocks go back; the next hour when it is skipped). */
export function zonedTime(y: number, m: number, d: number, hour: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, hour);
  let at = guess - zoneOffsetMs(guess, tz);
  const again = guess - zoneOffsetMs(at, tz);
  if (again !== at) at = Math.min(at, again);
  return at;
}

/** The next time a daily or weekly routine runs, strictly after `now`, in the workspace's zone. */
export function nextRunAt(now: number, tzRaw: string, trigger: RoutineTrigger, hour: number, weekday: number): number | null {
  if (trigger !== "daily" && trigger !== "weekly") return null;
  const tz = validZone(tzRaw || "UTC");
  const h = Math.min(23, Math.max(0, Math.trunc(hour)));
  const [y, m, d] = localDay(now, tz);
  for (let i = 0; i < 9; i++) {
    const base = new Date(Date.UTC(y, m - 1, d + i, 12));
    if (trigger === "weekly" && base.getUTCDay() !== weekday) continue;
    const at = zonedTime(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, tz);
    if (at > now) return at;
  }
  return null;
}

/** Numbers like [2] the answer cites, in order, only those that exist. */
export function citedNumbers(answer: string, count: number): number[] {
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) { const n = Number(m[1]); if (n >= 1 && n <= count && !out.includes(n)) out.push(n); }
  return out;
}

/** The UTC day start for the daily cap. */
export function dayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function describeSchedule(r: Pick<Routine, "trigger" | "hour" | "weekday">): string {
  const hh = `${String(r.hour).padStart(2, "0")}:00`;
  if (r.trigger === "daily") return `Every day at ${hh}`;
  if (r.trigger === "weekly") return `Every ${WEEKDAYS[r.weekday] ?? "Monday"} at ${hh}`;
  return TRIGGER_LABEL[r.trigger];
}

/** The friendly line the assistant posts in a thread when the workspace's free built in AI runs are used up (no AI call is made). */
export const FREE_LIMIT_REPLY = "This workspace's free AI runs are used up for now. Add your own AI key in Settings for unlimited use, or ask again later.";

/** Start of the free limit window: the UTC day, or the week from Monday 00:00 UTC. */
export function freeWindowStart(now: number, period: "day" | "week"): number {
  const d = dayStart(now);
  if (period === "day") return d;
  const back = (new Date(d).getUTCDay() + 6) % 7;
  return d - back * 86_400_000;
}

/** POL2 (HQ MB-329): a time in the workspace's zone, so "Every day at 09:00" and "Next ..." read on one clock.
 * The zone name is added only when the viewer's own clock differs. */
export function whenInZone(iso: string | null, zone: string | undefined, viewerZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  let tz = zone || "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = "UTC"; }
  const mine = viewerZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  if (mine !== tz) opts.timeZoneName = "short";
  return d.toLocaleString(undefined, opts);
}
