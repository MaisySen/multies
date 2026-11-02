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
  keepRunsDays: 30,
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
  ai: { on: boolean; key: boolean; provider: string | null };
  usedToday: number;
  caps: { runsPerDay: number; routinesMax: number; memoryMax: number };
  channels: { id: string; name: string; private: boolean }[];
  forms: { id: string; name: string }[];
  projects: { id: string; name: string }[];
}

/** One line of text: trims, folds runs of spaces and drops control characters (keeps new lines when asked). */
export function cleanText(raw: unknown, max: number, keepLines = false): string {
  const s = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
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
