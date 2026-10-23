import { ApiError } from "@/api/errors";
import type { Meeting, MeetingCreate, Message, Task, TimeEntry, TimeLog } from "@/api/types";
import type { SampleWork } from "./tasks";

/**
 * Time tracking and meetings for the sample workspace, kept on the phone like the rest of it.
 * Same paths and shapes as /api/time and /api/meetings. Video is off here, as on a workspace
 * with no video keys set.
 */
export interface SampleExtras { entries: TimeEntry[]; meetings: Meeting[]; seq: number }

const ORIGIN = "https://mymail.mymail-app.workers.dev";
const ME = { type: "member" as const, id: "usr_sample", name: "Mia Nguyen" };

function ref(t: Task) { return { id: t.id, ref: t.ref, title: t.title }; }

function entry(id: string, t: Task, startedAt: number, seconds: number, source: TimeEntry["source"], note = "", running = false): TimeEntry {
  return {
    id, taskId: t.id, task: ref(t), projectId: t.projectId, person: ME, startedAt: new Date(startedAt).toISOString(),
    endedAt: running ? null : new Date(startedAt + seconds * 1000).toISOString(), running, seconds, note, billable: true, source,
  };
}

function meeting(id: string, title: string, startsAt: Date, durationMin: number, source: Meeting["source"], invitees: string[] = []): Meeting {
  return {
    id, title, startsAt: startsAt.toISOString(), durationMin, endsAt: new Date(startsAt.getTime() + durationMin * 60_000).toISOString(),
    status: "scheduled", source, invitees, joinUrl: `${ORIGIN}/app/meetings/${id}`, guestUrl: `${ORIGIN}/m/sample${id.slice(-2)}`, videoEnabled: false,
  };
}

export function sampleExtras(now: number, work: SampleWork, messages: Message[]): SampleExtras {
  const open = work.tasks.filter((t) => t.status !== "done" && !t.parentId);
  const [a, b] = [open[0] ?? work.tasks[0], open[1] ?? work.tasks[0]];
  const day = 24 * 3600_000;
  const at = (daysFromNow: number, hour: number, minute = 0) => { const d = new Date(now + daysFromNow * day); d.setHours(hour, minute, 0, 0); return d; };
  const entries = a && b ? [
    entry("tim_s1", a, at(-1, 9).getTime(), 80 * 60, "timer", "Measured the counter and the power points"),
    entry("tim_s2", a, at(-2, 14).getTime(), 45 * 60, "manual", "Call with the joiner"),
    entry("tim_s3", b, at(-1, 11).getTime(), 25 * 60, "timer"),
  ] : [];
  const thread = messages.find((m) => m.folder === "inbox");
  const meetings = [
    meeting("mtg_s1", "Kiosk fit out walkthrough", at(1, 10), 30, thread ? { type: "thread", id: thread.threadId } : null, ["sam@greenroofcafe.com.au"]),
    meeting("mtg_s2", a ? `Catch up: ${a.title}` : "Weekly catch up", at(3, 14, 30), 45, a ? { type: "task", id: a.id } : null),
  ];
  return { entries, meetings, seq: 10 };
}

function findTask(work: SampleWork, idOrRef: string): Task {
  const t = work.tasks.find((x) => x.id === idOrRef || x.ref.toLowerCase() === idOrRef.toLowerCase());
  if (!t) throw new ApiError(404, "not_found", "Task not found.");
  return t;
}

function stopRunning(x: SampleExtras, now: number): TimeEntry | null {
  const run = x.entries.find((e) => e.running);
  if (!run) return null;
  run.running = false;
  run.seconds = Math.max(1, Math.floor((now - Date.parse(run.startedAt)) / 1000));
  run.endedAt = new Date(now).toISOString();
  return run;
}

function live(e: TimeEntry, now: number): TimeEntry {
  return e.running ? { ...e, seconds: Math.max(0, Math.floor((now - Date.parse(e.startedAt)) / 1000)) } : e;
}

/** The time a task screen shows: the total and the entries, newest first. */
export function taskTime(x: SampleExtras, taskId: string, now: number) {
  const entries = x.entries.filter((e) => e.taskId === taskId).map((e) => live(e, now)).sort((p, q) => q.startedAt.localeCompare(p.startedAt));
  return { totalSeconds: entries.reduce((n, e) => n + e.seconds, 0), entries };
}

/** Answers /time and /meetings paths; undefined for anything else. */
export function extrasRoute(x: SampleExtras, work: SampleWork, method: string, parts: string[], params: Record<string, string>, body: unknown, now = Date.now()): unknown {
  const [root, sub] = parts;
  if (root === "time") {
    if (method === "GET" && sub === "running") {
      const run = x.entries.find((e) => e.running);
      return { entry: run ? live(run, now) : null };
    }
    if (method === "POST" && sub === "start") {
      const b = (body ?? {}) as { taskId?: string; note?: string };
      const t = findTask(work, b.taskId ?? "");
      stopRunning(x, now);
      const e = entry(`tim_s${++x.seq}`, t, now, 0, "timer", b.note ?? "", true);
      x.entries.push(e);
      return { entry: e };
    }
    if (method === "POST" && sub === "stop") return { entry: stopRunning(x, now) };
    if (method === "POST" && !sub) {
      const b = (body ?? {}) as Partial<TimeLog>;
      const t = findTask(work, b.taskId ?? "");
      const minutes = Number(b.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new ApiError(422, "validation_error", "Minutes must be between 1 and 1440.");
      const start = b.date ? new Date(`${b.date}T09:00:00`).getTime() : now - minutes * 60_000;
      const e = entry(`tim_s${++x.seq}`, t, start, Math.round(minutes * 60), "manual", b.note ?? "");
      x.entries.push(e);
      return { entry: e };
    }
    if (method === "GET" && !sub) {
      const list = params.taskId ? x.entries.filter((e) => e.taskId === findTask(work, params.taskId).id) : x.entries;
      return { entries: list.map((e) => live(e, now)).sort((p, q) => q.startedAt.localeCompare(p.startedAt)) };
    }
    return undefined;
  }
  if (root === "meetings") {
    if (method === "GET" && !sub) {
      const from = params.upcoming ? now - 3 * 3600_000 : 0;
      return { meetings: x.meetings.filter((m) => Date.parse(m.startsAt) >= from).sort((p, q) => p.startsAt.localeCompare(q.startsAt)), videoEnabled: false };
    }
    if (method === "POST" && !sub) {
      const b = (body ?? {}) as MeetingCreate;
      const fromTask = b.source?.type === "task" ? findTask(work, b.source.id) : null;
      const title = b.title?.trim() || (fromTask ? fromTask.title : "Meeting");
      const m = meeting(`mtg_s${++x.seq}`, title, b.startsAt ? new Date(b.startsAt) : new Date(now), b.durationMin ?? 30, b.source ?? null, b.invitees ?? []);
      x.meetings.push(m);
      return { meeting: m, invites: { sent: 0 } };
    }
    return undefined;
  }
  return undefined;
}
