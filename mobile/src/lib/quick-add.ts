import type { Priority } from "@/api/types";
import { dayFrom } from "./tasks";

/**
 * R34: quick add that understands what you type. "Call Ana tomorrow 3pm @ana #ops !high" becomes
 * a title ("Call Ana"), a due date, an assignee handle, a project key and a priority. Every part it
 * understood is listed in `chips` so the sheet can show it and let the person tap one off.
 */
export interface QuickAdd {
  title: string;
  due: string | null; // YYYY-MM-DD
  time: string | null; // HH:MM, 24 h
  people: string[];
  project: string | null;
  priority: Priority | null;
  chips: { kind: "date" | "time" | "person" | "project" | "priority"; text: string }[];
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SHORT_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const PRIORITY: Record<string, Priority> = {
  "1": "urgent", "2": "high", "3": "medium", "4": "low", urgent: "urgent", high: "high", medium: "medium", med: "medium", low: "low",
  p1: "urgent", p2: "high", p3: "medium", p4: "low",
};

function weekday(word: string): number {
  const w = word.toLowerCase();
  const i = DAYS.indexOf(w);
  return i >= 0 ? i : SHORT_DAYS.indexOf(w);
}

/** Days to the coming `target` weekday (never today); "next" adds a week. */
function daysUntil(target: number, from: Date, forceNext = false): number {
  const d = (target - from.getDay() + 7) % 7 || 7;
  return forceNext ? d + 7 : d;
}

function iso(y: number, m: number, d: number): string | null {
  const dt = new Date(y, m, d);
  if (dt.getMonth() !== m || dt.getDate() !== d) return null;
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Parses one quick add line. `now` is the phone's local time. */
export function parseQuickAdd(input: string, now = new Date()): QuickAdd {
  const out: QuickAdd = { title: "", due: null, time: null, people: [], project: null, priority: null, chips: [] };
  let s = ` ${input.trim()} `;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => boolean | void) => {
    const m = s.match(re);
    if (!m || m.index === undefined) return;
    if (fn(m) === false) return;
    s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
  };

  // @people (several), #project (first one), !priority or p1..p4
  for (let m = s.match(/\s@([\w.\-]+)/); m; m = s.match(/\s@([\w.\-]+)/)) {
    out.people.push(m[1]); out.chips.push({ kind: "person", text: `@${m[1]}` });
    s = `${s.slice(0, m.index!)} ${s.slice(m.index! + m[0].length)}`;
  }
  take(/\s#([\w\-]+)/, (m) => { out.project = m[1]; out.chips.push({ kind: "project", text: `#${m[1]}` }); });
  take(/\s(?:!(urgent|high|medium|med|low|[1-4])|(p[1-4]))(?=\s)/i, (m) => {
    const p = PRIORITY[(m[1] ?? m[2]).toLowerCase()];
    out.priority = p; out.chips.push({ kind: "priority", text: p });
  });

  // time: "3pm", "3:30 pm", "15:00", "at 9"
  take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i, (m) => {
    let h = Number(m[1]) % 12; if (m[3].toLowerCase() === "pm") h += 12;
    const min = Number(m[2] ?? 0);
    if (h > 23 || min > 59) return false;
    out.time = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  });
  if (!out.time) take(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/, (m) => { out.time = `${m[1].padStart(2, "0")}:${m[2]}`; });

  // dates
  const setDue = (d: string | null, text: string) => { if (!d) return false; out.due = d; out.chips.unshift({ kind: "date", text }); };
  take(/\s(today|tonight|tod)(?=\s)/i, (m) => setDue(dayFrom(0, now), m[1].toLowerCase() === "tonight" ? "Tonight" : "Today"));
  if (!out.due) take(/\s(tomorrow|tmr|tmrw)(?=\s)/i, () => setDue(dayFrom(1, now), "Tomorrow"));
  if (!out.due) take(/\sin\s+(\d{1,3})\s+(day|days|week|weeks)(?=\s)/i, (m) => {
    const n = Number(m[1]) * (m[2].toLowerCase().startsWith("week") ? 7 : 1);
    return setDue(dayFrom(n, now), `In ${m[1]} ${m[2].toLowerCase()}`);
  });
  if (!out.due) take(/\snext\s+week(?=\s)/i, () => setDue(dayFrom(daysUntil(1, now), now), "Next week"));
  if (!out.due) take(/\s(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)(?=\s)/i, (m) => {
    const n = daysUntil(weekday(m[2]), now, !!m[1]);
    return setDue(dayFrom(n, now), `${m[1] ? "Next " : ""}${DAYS[weekday(m[2])][0].toUpperCase()}${DAYS[weekday(m[2])].slice(1, 3)}`);
  });
  if (!out.due) take(/\s(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?=\s)/i, (m) => {
    const mon = MONTHS.indexOf(m[2].toLowerCase());
    let y = now.getFullYear();
    let d = iso(y, mon, Number(m[1]));
    if (d && d < dayFrom(0, now)) { y += 1; d = iso(y, mon, Number(m[1])); }
    return setDue(d, `${Number(m[1])} ${m[2][0].toUpperCase()}${m[2].slice(1, 3).toLowerCase()}`);
  });
  if (!out.due) take(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/, (m) => {
    // Day first, the way Australia writes dates.
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : now.getFullYear();
    let d = iso(y, Number(m[2]) - 1, Number(m[1]));
    if (d && !m[3] && d < dayFrom(0, now)) { y += 1; d = iso(y, Number(m[2]) - 1, Number(m[1])); }
    return setDue(d, `${Number(m[1])}/${Number(m[2])}${m[3] ? `/${m[3]}` : ""}`);
  });
  if (out.time) {
    if (!out.due) { out.due = dayFrom(0, now); out.chips.unshift({ kind: "date", text: "Today" }); }
    out.chips.splice(1, 0, { kind: "time", text: out.time });
  }

  out.title = s.replace(/\s+/g, " ").trim().replace(/\s+(on|by|due)$/i, "");
  return out;
}

/** What a quick add line sets on a new task, matched against known projects and people. */
export function quickAddToTask<Id extends string = string>(
  q: QuickAdd,
  projects: readonly { id: string; key: string; name: string }[] = [],
  people: readonly { id: Id; name: string; email: string | null }[] = [],
): { title: string; due?: string; priority?: Priority; projectId?: string; assigneeId?: Id; unmatched: string[] } {
  const out: { title: string; due?: string; priority?: Priority; projectId?: string; assigneeId?: Id; unmatched: string[] } = { title: q.title, unmatched: [] };
  if (q.due) out.due = q.due;
  if (q.priority) out.priority = q.priority;
  if (q.project) {
    const k = q.project.toLowerCase();
    const p = projects.find((x) => x.key.toLowerCase() === k) ?? projects.find((x) => x.name.toLowerCase().replace(/\s+/g, "-") === k)
      ?? projects.find((x) => x.name.toLowerCase().startsWith(k));
    if (p) out.projectId = p.id; else out.unmatched.push(`#${q.project}`);
  }
  if (q.people[0]) {
    const h = q.people[0].toLowerCase();
    const a = people.find((x) => x.email?.toLowerCase().split("@")[0] === h) ?? people.find((x) => x.name.toLowerCase().split(" ")[0] === h)
      ?? people.find((x) => x.name.toLowerCase().replace(/\s+/g, "") === h);
    if (a) out.assigneeId = a.id; else out.unmatched.push(`@${q.people[0]}`);
  }
  return out;
}
