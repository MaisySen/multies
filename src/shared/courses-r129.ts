/**
 * R129: courses (staff training), the parts both the server and the web read. A course is a doc with kind "course":
 * ordered lessons (a Docs page, a file or video link, a short text, or a quiz), learners (assigned or started on their
 * own), progress per lesson and a certificate on completion. Quizzes are scored on the server; the learner view of a
 * quiz never carries the answer key.
 */

export const LESSON_TYPES = ["page", "file", "video", "text", "quiz"] as const;
export type LessonType = (typeof LESSON_TYPES)[number];
export const QUESTION_TYPES = ["single", "multi", "short"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const LIMITS = { lessons: 200, questions: 50, options: 10, title: 200, body: 5000, prompt: 1000, option: 300, learnersPerAssign: 500, attemptsPerDay: 20 } as const;

/** A quiz question as the course holds it (with the key). */
export interface Question { id: string; prompt: string; type: QuestionType; options: string[]; correct: number[]; accepted: string[] }
/** A quiz question as a learner sees it: no key. */
export interface PublicQuestion { id: string; prompt: string; type: QuestionType; options: string[] }

export type Answer = number | number[] | string | null | undefined;

export const LESSON_LABEL: Record<LessonType, string> = { page: "Docs page", file: "File", video: "Video", text: "Text", quiz: "Quiz" };

/** Strip the answer key: what a learner may receive. */
export function publicQuestions(qs: Question[]): PublicQuestion[] {
  return qs.map((q) => ({ id: q.id, prompt: q.prompt, type: q.type, options: q.type === "short" ? [] : [...q.options] }));
}

const fold = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** Is one answer right? Single: the same option. Several: exactly the same set. Short: equal after trim and case fold. */
export function isRight(q: Question, a: Answer): boolean {
  if (q.type === "single") return typeof a === "number" && q.correct.length === 1 && a === q.correct[0];
  if (q.type === "multi") {
    if (!Array.isArray(a)) return false;
    const got = [...new Set(a.filter((n) => Number.isInteger(n)))].sort((x, y) => x - y);
    const want = [...new Set(q.correct)].sort((x, y) => x - y);
    return want.length > 0 && got.length === want.length && got.every((n, i) => n === want[i]);
  }
  if (typeof a !== "string" || !a.trim()) return false;
  return q.accepted.some((x) => fold(x) === fold(a));
}

export interface QuizResult { score: number; right: number; total: number; passed: boolean; wrong: string[] }

/** Score a quiz (0 to 100, rounded down) and say which questions were wrong. Never says what the right answer is. */
export function scoreQuiz(qs: Question[], answers: Record<string, Answer>, passMark: number): QuizResult {
  const total = qs.length;
  const wrong = qs.filter((q) => !isRight(q, answers[q.id])).map((q) => q.id);
  const right = total - wrong.length;
  const score = total ? Math.floor((right * 100) / total) : 0;
  return { score, right, total, passed: total > 0 && score >= clampMark(passMark), wrong };
}

export const clampMark = (n: unknown, fallback = 80) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : fallback;
};

/** Problems that stop a quiz being saved (plain words), or none. */
export function checkQuestions(qs: Question[]): string | null {
  if (qs.length > LIMITS.questions) return `A quiz can have up to ${LIMITS.questions} questions.`;
  const seen = new Set<string>();
  for (const [i, q] of qs.entries()) {
    const n = i + 1;
    if (seen.has(q.id)) return `Question ${n} has the same id as another.`;
    seen.add(q.id);
    if (!q.prompt.trim()) return `Question ${n} needs a question.`;
    if (q.type === "short") { if (!q.accepted.some((a) => a.trim())) return `Question ${n} needs at least one accepted answer.`; continue; }
    const opts = q.options.map((o) => o.trim());
    if (opts.length < 2) return `Question ${n} needs at least two options.`;
    if (opts.some((o) => !o)) return `Question ${n} has an empty option.`;
    if (opts.length > LIMITS.options) return `Question ${n} can have up to ${LIMITS.options} options.`;
    if (!q.correct.length || q.correct.some((c) => !Number.isInteger(c) || c < 0 || c >= opts.length)) return `Question ${n} needs a right answer.`;
    if (q.type === "single" && q.correct.length !== 1) return `Question ${n} can have only one right answer.`;
  }
  return null;
}

export interface LessonState { id: string; type: LessonType; required: boolean; done: boolean; passed: boolean }

/** A lesson counts as done when marked done; a quiz only when passed. */
export const lessonComplete = (l: LessonState) => (l.type === "quiz" ? l.passed : l.done);

/** Progress in percent over required lessons (all lessons when none is required), and whether the course is complete. */
export function courseProgress(lessons: LessonState[]): { percent: number; done: number; total: number; complete: boolean } {
  const counted = lessons.some((l) => l.required) ? lessons.filter((l) => l.required) : lessons;
  const done = counted.filter(lessonComplete).length;
  const total = counted.length;
  return { percent: total ? Math.floor((done * 100) / total) : 0, done, total, complete: total > 0 && done === total };
}

export type LearnerStatus = "not_started" | "in_progress" | "overdue" | "completed";
export const STATUS_LABEL: Record<LearnerStatus, string> = { not_started: "Not started", in_progress: "In progress", overdue: "Overdue", completed: "Completed" };

export function learnerStatus(l: { startedAt?: number | null; completedAt?: number | null; dueAt?: number | null }, now: number): LearnerStatus {
  if (l.completedAt) return "completed";
  if (l.dueAt && l.dueAt < now) return "overdue";
  return l.startedAt ? "in_progress" : "not_started";
}

export const SOON_MS = 48 * 3600_000;

/** Which reminder (if any) is due for a learner now: one "soon" inside 48 hours of the due time, one "overdue" after it. */
export function reminderDue(l: { dueAt?: number | null; completedAt?: number | null; remindedSoonAt?: number | null; remindedOverdueAt?: number | null }, now: number): "soon" | "overdue" | null {
  if (!l.dueAt || l.completedAt) return null;
  if (l.dueAt < now) return l.remindedOverdueAt ? null : "overdue";
  if (l.dueAt - now <= SOON_MS) return l.remindedSoonAt ? null : "soon";
  return null;
}

/** A CSV cell, quoted when needed; a leading = + - @ is made safe for spreadsheets. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

/** A safe http(s) link or null. */
export function safeLink(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 2000) return null;
  try { const x = new URL(u.trim()); return x.protocol === "https:" || x.protocol === "http:" ? x.toString() : null; } catch { return null; }
}
