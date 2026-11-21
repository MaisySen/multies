/**
 * R129: courses, a doc type (docs.kind "course"). Lessons (a Docs page, a file or video link, a short text, a quiz),
 * learners (assigned with an optional due date, or started on their own), progress per lesson, quizzes scored here on
 * the server (the learner view never carries the key), reminders through notify(), a CSV of progress and a branded
 * certificate PDF (pdf-lib, MIT).
 *
 * Access: owners, admins, the creator and course editors build, publish and assign; every member can take a published
 * course and sees only their own progress; owners, admins, editors and course managers see the progress table. Read
 * only keys never write. Guests read a published course in their project (no progress, no quiz). vv8k is always out.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { courseLearners, courseLessons, courseProgress, docCourses, docs, members, organizations, users } from "../db/schema";
import { HttpError, notFound } from "../lib/errors";
import { inIds } from "../lib/sql-chunks";
import { createDoc } from "./suite/docs";
import { assertWritable, recordWrite, sortableId, type SuiteActor } from "./suite/common";
import { notify } from "./suite/notify";
import { canTrash } from "./trash-rules-pol1"; // POL1
import { getBrand } from "../routes/branding";
import {
  checkQuestions, clampMark, courseProgress as progressOf, learnerStatus, LIMITS, publicQuestions, reminderDue, safeLink, scoreQuiz, STATUS_LABEL, toCsv,
  type Answer, type LessonType, type Question,
} from "@/shared/courses-r129";
import { featureOn } from "./console/flags"; // OPS1 feature flags

export type Viewer = { kind: "member"; actor: SuiteActor } | { kind: "guest"; actor: SuiteActor; projectId: string };
type Meta = typeof docCourses.$inferSelect;
type LessonRow = typeof courseLessons.$inferSelect;
type LearnerRow = typeof courseLearners.$inferSelect;

const ID = /^[\w-]{1,64}$/;
const unprocessable = (code: string, message: string) => new HttpError(422, code, message);
const forbidden = (message: string) => new HttpError(403, "forbidden", message);
const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const ids = (json: string): string[] => { try { const v = JSON.parse(json) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : []; } catch { return []; } };
const readQuiz = (json: string): Question[] => {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.map((q: Partial<Question>) => ({ id: String(q.id ?? ""), prompt: String(q.prompt ?? ""), type: q.type === "multi" || q.type === "short" ? q.type : "single", options: Array.isArray(q.options) ? q.options.map(String) : [], correct: Array.isArray(q.correct) ? q.correct.map(Number) : [], accepted: Array.isArray(q.accepted) ? q.accepted.map(String) : [] }));
  } catch { return []; }
};

// ---------------------------------------------------------------- on and off

/** vv8k is always out; COURSES_EXCLUDE adds more (ids, slugs or names, comma separated). */
export function isCoursesExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}
export async function assertCoursesOn(deps: Deps, orgId: string) {
  if (!featureOn(deps, "coursesR129", orgId)) throw notFound("Page"); // OPS1: per workspace flag
  const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).get();
  if (!o || isCoursesExcluded(o, deps.config.coursesExclude ?? "")) throw notFound("Page");
}

// ---------------------------------------------------------------- roles

const isAdmin = (a: SuiteActor) => a.role === "owner" || a.role === "admin";
export function canBuild(a: SuiteActor, meta: Pick<Meta, "createdBy" | "editors">): boolean {
  if (a.scope === "read") return false;
  return isAdmin(a) || (!!a.userId && (a.userId === meta.createdBy || ids(meta.editors).includes(a.userId)));
}
export function canSeeProgress(a: SuiteActor, meta: Pick<Meta, "createdBy" | "editors" | "managers">): boolean {
  return isAdmin(a) || (!!a.userId && (a.userId === meta.createdBy || ids(meta.editors).includes(a.userId) || ids(meta.managers).includes(a.userId)));
}
function mustBuild(a: SuiteActor, meta: Meta) {
  assertWritable(a);
  if (!canBuild(a, meta)) throw forbidden("Only admins and this course's editors can change it.");
}

async function loadCourse(deps: Deps, viewer: Viewer, docId: string): Promise<{ meta: Meta; title: string; projectId: string | null }> {
  if (!ID.test(docId)) throw notFound("Course");
  const orgId = viewer.actor.orgId;
  const d = await deps.db.select({ id: docs.id, title: docs.title, kind: docs.kind, projectId: docs.projectId }).from(docs).where(and(eq(docs.id, docId), eq(docs.orgId, orgId), isNull(docs.deletedAt))).get();
  if (!d || d.kind !== "course") throw notFound("Course");
  const meta = await deps.db.select().from(docCourses).where(and(eq(docCourses.docId, docId), eq(docCourses.orgId, orgId))).get();
  if (!meta) throw notFound("Course");
  if (viewer.kind === "guest" && (d.projectId !== viewer.projectId || meta.status !== "published")) throw notFound("Course");
  return { meta, title: d.title, projectId: d.projectId };
}

async function lessonsOf(deps: Deps, orgId: string, docId: string): Promise<LessonRow[]> {
  return deps.db.select().from(courseLessons).where(and(eq(courseLessons.orgId, orgId), eq(courseLessons.docId, docId), isNull(courseLessons.deletedAt))).orderBy(asc(courseLessons.position)).limit(LIMITS.lessons);
}

async function learnerOf(deps: Deps, orgId: string, docId: string, userId: string) {
  return deps.db.select().from(courseLearners).where(and(eq(courseLearners.orgId, orgId), eq(courseLearners.docId, docId), eq(courseLearners.userId, userId))).get();
}

async function progressFor(deps: Deps, orgId: string, learnerIds: string[]) {
  if (!learnerIds.length) return [];
  return deps.db.select().from(courseProgress).where(and(eq(courseProgress.orgId, orgId), inIds(courseProgress.learnerId, learnerIds)));
}

// ---------------------------------------------------------------- present

function lessonFor(l: LessonRow, builder: boolean) {
  const quiz = readQuiz(l.quiz);
  return {
    id: l.id, title: l.title, type: l.type as LessonType, refDocId: l.refDocId, url: l.url, body: l.body, required: l.required, passMark: l.passMark,
    questionCount: quiz.length,
    ...(builder ? { quiz } : { questions: publicQuestions(quiz) }),
  };
}

function stateOf(lessons: LessonRow[], prog: (typeof courseProgress.$inferSelect)[]) {
  const by = new Map(prog.map((p) => [p.lessonId, p]));
  return lessons.map((l) => { const p = by.get(l.id); return { id: l.id, type: l.type as LessonType, required: l.required, done: !!p?.doneAt, passed: !!p?.passed }; });
}

export async function listCourses(deps: Deps, actor: SuiteActor) {
  const rows = await deps.db.select({ id: docs.id, title: docs.title, status: docCourses.status }).from(docs).innerJoin(docCourses, eq(docCourses.docId, docs.id))
    .where(and(eq(docs.orgId, actor.orgId), eq(docs.kind, "course"), isNull(docs.deletedAt))).orderBy(asc(docs.title)).limit(200);
  return rows;
}

export async function courseDetail(deps: Deps, viewer: Viewer, docId: string) {
  const { meta, title } = await loadCourse(deps, viewer, docId);
  const a = viewer.actor;
  const member = viewer.kind === "member";
  const builder = member && canBuild(a, meta);
  if (!builder && meta.status !== "published") throw new HttpError(403, "course_draft", "This course is not published yet.");
  const lessons = await lessonsOf(deps, a.orgId, docId);
  let me: null | { id: string; source: string; dueAt: number | null; startedAt: number | null; completedAt: number | null; certificateNo: string | null; status: string; percent: number; lessons: Record<string, { done: boolean; passed: boolean; bestScore: number | null; attempts: number }> } = null;
  if (member && a.userId) {
    const l = await learnerOf(deps, a.orgId, docId, a.userId);
    if (l && !l.removedAt) {
      const prog = await progressFor(deps, a.orgId, [l.id]);
      const p = progressOf(stateOf(lessons, prog));
      me = {
        id: l.id, source: l.source, dueAt: ms(l.dueAt), startedAt: ms(l.startedAt), completedAt: ms(l.completedAt), certificateNo: l.completedAt && meta.certificate ? l.certificateNo : null,
        status: learnerStatus({ startedAt: ms(l.startedAt), completedAt: ms(l.completedAt), dueAt: ms(l.dueAt) }, deps.now().getTime()), percent: l.completedAt ? 100 : p.percent,
        lessons: Object.fromEntries(prog.map((x) => [x.lessonId, { done: !!x.doneAt, passed: x.passed, bestScore: x.bestScore, attempts: x.attempts }])),
      };
    }
  }
  return {
    course: {
      id: docId, title, status: meta.status, passMark: meta.passMark, certificate: meta.certificate,
      ...(builder ? { editors: ids(meta.editors), managers: ids(meta.managers), createdBy: meta.createdBy } : {}),
      canBuild: builder, canDelete: featureOn(deps, "polishPol1", a.orgId) && member && canTrash(a, "course", meta.createdBy), canSeeProgress: member && canSeeProgress(a, meta), canLearn: member && !!a.userId && a.scope !== "read", guest: !member, // POL1: canDelete
    },
    lessons: lessons.map((l) => lessonFor(l, builder)),
    me,
  };
}

// ---------------------------------------------------------------- build

export async function createCourse(deps: Deps, actor: SuiteActor, input: { title?: string; parentId?: string | null; projectId?: string | null }) {
  assertWritable(actor);
  const doc = await createDoc(deps, actor, { title: (input.title ?? "").trim() || "Untitled course", text: "", parentId: input.parentId ?? null, projectId: input.projectId ?? null });
  await deps.db.update(docs).set({ kind: "course" }).where(and(eq(docs.id, doc.id), eq(docs.orgId, actor.orgId)));
  await deps.db.insert(docCourses).values({ docId: doc.id, orgId: actor.orgId, createdBy: actor.userId || null, createdAt: deps.now(), updatedAt: deps.now() });
  return { id: doc.id, title: doc.title };
}

export async function updateCourse(deps: Deps, actor: SuiteActor, docId: string, b: { status?: "draft" | "published"; passMark?: number; certificate?: boolean; editors?: string[]; managers?: string[] }) {
  const { meta } = await loadCourse(deps, { kind: "member", actor }, docId);
  mustBuild(actor, meta);
  if ((b.editors || b.managers) && !isAdmin(actor) && actor.userId !== meta.createdBy) throw forbidden("Only admins and the course's creator can change who edits or manages it.");
  for (const list of [b.editors, b.managers]) if (list) await assertMembers(deps, actor.orgId, list);
  if (b.status === "published" && (await lessonsOf(deps, actor.orgId, docId)).length === 0) throw unprocessable("no_lessons", "Add a lesson before you publish.");
  await deps.db.update(docCourses).set({
    ...(b.status ? { status: b.status } : {}), ...(b.passMark !== undefined ? { passMark: clampMark(b.passMark) } : {}), ...(b.certificate !== undefined ? { certificate: b.certificate } : {}),
    ...(b.editors ? { editors: JSON.stringify([...new Set(b.editors)]) } : {}), ...(b.managers ? { managers: JSON.stringify([...new Set(b.managers)]) } : {}), updatedAt: deps.now(),
  }).where(and(eq(docCourses.docId, docId), eq(docCourses.orgId, actor.orgId)));
  await recordWrite(deps, actor, { entityType: "doc", entityId: docId, op: "update", verb: b.status === "published" ? "published" : "updated", data: { course: true } });
  return courseDetail(deps, { kind: "member", actor }, docId);
}

async function assertMembers(deps: Deps, orgId: string, userIds: string[]) {
  const want = [...new Set(userIds)].filter((x) => ID.test(x));
  if (want.length !== new Set(userIds).size) throw unprocessable("bad_people", "Someone in the list is not in this workspace.");
  if (!want.length) return [];
  const rows = await deps.db.select({ userId: members.userId, kind: members.kind }).from(members).where(and(eq(members.organizationId, orgId), inIds(members.userId, want)));
  const humans = rows.filter((r) => r.kind === "human").map((r) => r.userId);
  if (humans.length !== want.length) throw unprocessable("bad_people", "Someone in the list is not in this workspace.");
  return humans;
}

export interface LessonIn { title?: string; type?: LessonType; refDocId?: string | null; url?: string | null; body?: string; quiz?: Question[]; passMark?: number | null; required?: boolean; afterId?: string | null }

async function cleanLesson(deps: Deps, actor: SuiteActor, type: LessonType, b: LessonIn) {
  const out: Partial<typeof courseLessons.$inferInsert> = {};
  if (b.title !== undefined) { const t = b.title.trim().slice(0, LIMITS.title); if (!t) throw unprocessable("no_title", "Give the lesson a title."); out.title = t; }
  if (b.body !== undefined) out.body = b.body.slice(0, LIMITS.body);
  if (b.required !== undefined) out.required = b.required;
  if (b.passMark !== undefined) out.passMark = b.passMark === null ? null : clampMark(b.passMark);
  if (type === "page" && b.refDocId !== undefined) {
    if (!b.refDocId || !ID.test(b.refDocId)) throw unprocessable("no_page", "Pick a Docs page.");
    const d = await deps.db.select({ kind: docs.kind }).from(docs).where(and(eq(docs.id, b.refDocId), eq(docs.orgId, actor.orgId), isNull(docs.deletedAt))).get();
    if (!d || d.kind === "course") throw unprocessable("no_page", "Pick a Docs page.");
    out.refDocId = b.refDocId;
  }
  if ((type === "file" || type === "video") && b.url !== undefined) {
    const u = safeLink(b.url);
    if (!u) throw unprocessable("bad_link", "Add a link that starts with https://");
    out.url = u;
  }
  if (type === "quiz" && b.quiz !== undefined) {
    const q = b.quiz.map((x) => ({ id: x.id, prompt: x.prompt.trim().slice(0, LIMITS.prompt), type: x.type, options: x.type === "short" ? [] : x.options.map((o) => o.trim().slice(0, LIMITS.option)), correct: x.type === "short" ? [] : x.correct, accepted: x.type === "short" ? x.accepted.map((a) => a.trim().slice(0, LIMITS.option)).filter(Boolean) : [] }));
    const problem = checkQuestions(q);
    if (problem) throw unprocessable("bad_quiz", problem);
    out.quiz = JSON.stringify(q);
  }
  return out;
}

export async function createLesson(deps: Deps, actor: SuiteActor, docId: string, b: LessonIn & { type: LessonType; title: string }) {
  const { meta } = await loadCourse(deps, { kind: "member", actor }, docId);
  mustBuild(actor, meta);
  const list = await lessonsOf(deps, actor.orgId, docId);
  if (list.length >= LIMITS.lessons) throw unprocessable("too_many", `A course can have up to ${LIMITS.lessons} lessons.`);
  if (b.type === "page" && !b.refDocId) throw unprocessable("no_page", "Pick a Docs page.");
  if ((b.type === "file" || b.type === "video") && !b.url) throw unprocessable("bad_link", "Add a link that starts with https://");
  const clean = await cleanLesson(deps, actor, b.type, b);
  const at = b.afterId ? list.findIndex((l) => l.id === b.afterId) : list.length - 1;
  const before = at >= 0 ? list[at]?.position ?? 0 : 0;
  const next = list[at + 1]?.position;
  const position = next === undefined ? before + 1 : (before + next) / 2;
  const id = sortableId("les");
  await deps.db.insert(courseLessons).values({ id, orgId: actor.orgId, docId, type: b.type, title: clean.title ?? "Untitled lesson", ...clean, position, createdAt: deps.now(), updatedAt: deps.now() });
  await touch(deps, actor, docId);
  return lessonFor((await deps.db.select().from(courseLessons).where(eq(courseLessons.id, id)).get())!, true);
}

export async function updateLesson(deps: Deps, actor: SuiteActor, docId: string, lessonId: string, b: LessonIn & { position?: number }) {
  const { meta } = await loadCourse(deps, { kind: "member", actor }, docId);
  mustBuild(actor, meta);
  const l = await deps.db.select().from(courseLessons).where(and(eq(courseLessons.id, lessonId), eq(courseLessons.orgId, actor.orgId), eq(courseLessons.docId, docId), isNull(courseLessons.deletedAt))).get();
  if (!l) throw notFound("Lesson");
  const clean = await cleanLesson(deps, actor, l.type as LessonType, b);
  const position = b.position !== undefined && Number.isFinite(b.position) ? b.position : undefined;
  await deps.db.update(courseLessons).set({ ...clean, ...(position !== undefined ? { position } : {}), updatedAt: deps.now() }).where(eq(courseLessons.id, l.id));
  await touch(deps, actor, docId);
  return lessonFor((await deps.db.select().from(courseLessons).where(eq(courseLessons.id, l.id)).get())!, true);
}

/** Move a lesson up or down one place (one row written). */
export async function moveLesson(deps: Deps, actor: SuiteActor, docId: string, lessonId: string, dir: "up" | "down") {
  const { meta } = await loadCourse(deps, { kind: "member", actor }, docId);
  mustBuild(actor, meta);
  const list = await lessonsOf(deps, actor.orgId, docId);
  const i = list.findIndex((l) => l.id === lessonId);
  if (i < 0) throw notFound("Lesson");
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return { lessons: list.map((l) => lessonFor(l, true)) };
  const k = dir === "up" ? j - 1 : j + 1;
  const edge = list[k]?.position;
  const target = list[j].position;
  const position = edge === undefined ? (dir === "up" ? target - 1 : target + 1) : (target + edge) / 2;
  await deps.db.update(courseLessons).set({ position, updatedAt: deps.now() }).where(eq(courseLessons.id, lessonId));
  return { lessons: (await lessonsOf(deps, actor.orgId, docId)).map((l) => lessonFor(l, true)) };
}

export async function deleteLesson(deps: Deps, actor: SuiteActor, docId: string, lessonId: string) {
  const { meta } = await loadCourse(deps, { kind: "member", actor }, docId);
  mustBuild(actor, meta);
  const r = await deps.db.update(courseLessons).set({ deletedAt: deps.now() }).where(and(eq(courseLessons.id, lessonId), eq(courseLessons.orgId, actor.orgId), eq(courseLessons.docId, docId), isNull(courseLessons.deletedAt))).returning({ id: courseLessons.id });
  if (!r.length) throw notFound("Lesson");
  await touch(deps, actor, docId);
  return { ok: true };
}

async function touch(deps: Deps, actor: SuiteActor, docId: string) {
  await deps.db.update(docCourses).set({ updatedAt: deps.now() }).where(and(eq(docCourses.docId, docId), eq(docCourses.orgId, actor.orgId)));
}

/** A Docs page lesson's words, for reading inside the course (the page itself stays in Docs). */
export async function lessonPage(deps: Deps, viewer: Viewer, docId: string, lessonId: string) {
  const { meta } = await loadCourse(deps, viewer, docId);
  if (meta.status !== "published" && !(viewer.kind === "member" && canBuild(viewer.actor, meta))) throw new HttpError(403, "course_draft", "This course is not published yet.");
  const l = await deps.db.select().from(courseLessons).where(and(eq(courseLessons.id, lessonId), eq(courseLessons.orgId, viewer.actor.orgId), eq(courseLessons.docId, docId), isNull(courseLessons.deletedAt))).get();
  if (!l || l.type !== "page" || !l.refDocId) throw notFound("Lesson");
  const d = await deps.db.select({ id: docs.id, title: docs.title, plainText: docs.plainText, projectId: docs.projectId }).from(docs).where(and(eq(docs.id, l.refDocId), eq(docs.orgId, viewer.actor.orgId), isNull(docs.deletedAt))).get();
  if (!d || (viewer.kind === "guest" && d.projectId !== viewer.projectId)) return { page: null };
  return { page: { id: d.id, title: d.title, text: d.plainText.slice(0, 100_000) } };
}

// ---------------------------------------------------------------- learn

async function ensureLearner(deps: Deps, actor: SuiteActor, docId: string): Promise<LearnerRow> {
  if (!actor.userId) throw forbidden("Sign in as a person to take a course.");
  assertWritable(actor);
  const now = deps.now();
  const l = await learnerOf(deps, actor.orgId, docId, actor.userId);
  if (l && !l.removedAt) {
    if (!l.startedAt) await deps.db.update(courseLearners).set({ startedAt: now }).where(eq(courseLearners.id, l.id));
    return { ...l, startedAt: l.startedAt ?? now };
  }
  if (l) {
    await deps.db.update(courseLearners).set({ removedAt: null, source: "self", startedAt: now, dueAt: null }).where(eq(courseLearners.id, l.id));
    return { ...l, removedAt: null, source: "self", startedAt: now, dueAt: null };
  }
  const row = { id: sortableId("lrn"), orgId: actor.orgId, docId, userId: actor.userId, source: "self" as const, startedAt: now, createdAt: now };
  await deps.db.insert(courseLearners).values(row).onConflictDoNothing();
  return (await learnerOf(deps, actor.orgId, docId, actor.userId))!;
}

async function learnable(deps: Deps, actor: SuiteActor, docId: string) {
  const c = await loadCourse(deps, { kind: "member", actor }, docId);
  if (c.meta.status !== "published") throw new HttpError(403, "course_draft", "This course is not published yet.");
  return c;
}

export async function startCourse(deps: Deps, actor: SuiteActor, docId: string) {
  await learnable(deps, actor, docId);
  await ensureLearner(deps, actor, docId);
  return courseDetail(deps, { kind: "member", actor }, docId);
}

async function lessonIn(deps: Deps, orgId: string, docId: string, lessonId: string) {
  if (!ID.test(lessonId)) throw notFound("Lesson");
  const l = await deps.db.select().from(courseLessons).where(and(eq(courseLessons.id, lessonId), eq(courseLessons.orgId, orgId), eq(courseLessons.docId, docId), isNull(courseLessons.deletedAt))).get();
  if (!l) throw notFound("Lesson");
  return l;
}

export async function markDone(deps: Deps, actor: SuiteActor, docId: string, lessonId: string, done: boolean) {
  const { meta } = await learnable(deps, actor, docId);
  const l = await lessonIn(deps, actor.orgId, docId, lessonId);
  if (l.type === "quiz") throw unprocessable("quiz_lesson", "Pass the quiz to finish this lesson.");
  const learner = await ensureLearner(deps, actor, docId);
  const now = deps.now();
  await deps.db.insert(courseProgress).values({ learnerId: learner.id, lessonId, orgId: actor.orgId, doneAt: done ? now : null, updatedAt: now })
    .onConflictDoUpdate({ target: [courseProgress.learnerId, courseProgress.lessonId], set: { doneAt: done ? now : null, updatedAt: now } });
  await settle(deps, actor, meta, learner);
  return courseDetail(deps, { kind: "member", actor }, docId);
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

export async function submitQuiz(deps: Deps, actor: SuiteActor, docId: string, lessonId: string, answers: Record<string, Answer>) {
  const { meta } = await learnable(deps, actor, docId);
  const l = await lessonIn(deps, actor.orgId, docId, lessonId);
  if (l.type !== "quiz") throw unprocessable("not_quiz", "This lesson has no quiz.");
  const qs = readQuiz(l.quiz);
  if (!qs.length) throw unprocessable("empty_quiz", "This quiz has no questions yet.");
  const learner = await ensureLearner(deps, actor, docId);
  const now = deps.now(), day = dayOf(now);
  const prev = await deps.db.select().from(courseProgress).where(and(eq(courseProgress.learnerId, learner.id), eq(courseProgress.lessonId, lessonId))).get();
  const today = prev?.attemptDay === day ? prev.dayAttempts : 0;
  if (today >= LIMITS.attemptsPerDay) throw new HttpError(429, "too_many_attempts", "That is a lot of tries for one day. Take a break and try again tomorrow.");
  const r = scoreQuiz(qs, answers, l.passMark ?? meta.passMark);
  const passed = r.passed || !!prev?.passed;
  const best = Math.max(r.score, prev?.bestScore ?? 0);
  const set = { score: r.score, bestScore: best, attempts: (prev?.attempts ?? 0) + 1, attemptDay: day, dayAttempts: today + 1, passed, doneAt: passed ? prev?.doneAt ?? now : null, updatedAt: now };
  await deps.db.insert(courseProgress).values({ learnerId: learner.id, lessonId, orgId: actor.orgId, ...set }).onConflictDoUpdate({ target: [courseProgress.learnerId, courseProgress.lessonId], set });
  await settle(deps, actor, meta, learner);
  return { result: { score: r.score, right: r.right, total: r.total, passed: r.passed, passMark: l.passMark ?? meta.passMark, wrong: r.wrong }, detail: await courseDetail(deps, { kind: "member", actor }, docId) };
}

/** After progress changes: set completion (once) and a certificate number. */
async function settle(deps: Deps, actor: SuiteActor, meta: Meta, learner: LearnerRow) {
  const fresh = await deps.db.select().from(courseLearners).where(eq(courseLearners.id, learner.id)).get();
  if (!fresh || fresh.completedAt) return;
  const lessons = await lessonsOf(deps, actor.orgId, meta.docId);
  const prog = await progressFor(deps, actor.orgId, [learner.id]);
  if (!progressOf(stateOf(lessons, prog)).complete) return;
  const now = deps.now();
  await deps.db.update(courseLearners).set({ completedAt: now, certificateNo: certificateNo(now) }).where(and(eq(courseLearners.id, learner.id), isNull(courseLearners.completedAt)));
  await recordWrite(deps, actor, { entityType: "doc", entityId: meta.docId, op: "update", verb: "course_completed", data: { learner: learner.id } });
}

export function certificateNo(now: Date) {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `C${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}-${rand}`;
}

// ---------------------------------------------------------------- assign

export async function assign(deps: Deps, actor: SuiteActor, docId: string, b: { userIds?: string[]; everyone?: boolean; dueAt?: number | null }) {
  const { meta, title } = await loadCourse(deps, { kind: "member", actor }, docId);
  mustBuild(actor, meta);
  if (meta.status !== "published") throw unprocessable("course_draft", "Publish the course before you assign it.");
  const now = deps.now();
  if (b.dueAt !== undefined && b.dueAt !== null && (!Number.isFinite(b.dueAt) || b.dueAt < now.getTime() - 86_400_000)) throw unprocessable("bad_due", "Pick a due date from today on.");
  let people: string[];
  if (b.everyone) {
    const rows = await deps.db.select({ userId: members.userId }).from(members).where(and(eq(members.organizationId, actor.orgId), eq(members.kind, "human"), isNull(members.disabledAt))).limit(LIMITS.learnersPerAssign);
    people = rows.map((r) => r.userId);
  } else {
    people = await assertMembers(deps, actor.orgId, (b.userIds ?? []).slice(0, LIMITS.learnersPerAssign + 1));
    if (people.length > LIMITS.learnersPerAssign) throw unprocessable("too_many", `Assign up to ${LIMITS.learnersPerAssign} people at a time.`);
  }
  if (!people.length) throw unprocessable("no_people", "Pick at least one person.");
  const due = b.dueAt ? new Date(b.dueAt) : null;
  const existing = await deps.db.select().from(courseLearners).where(and(eq(courseLearners.orgId, actor.orgId), eq(courseLearners.docId, docId), inIds(courseLearners.userId, people)));
  const have = new Map(existing.map((e) => [e.userId, e]));
  let added = 0;
  for (const userId of people) {
    const e = have.get(userId);
    if (e) {
      await deps.db.update(courseLearners).set({ source: "assigned", assignedBy: actor.userId || null, dueAt: due, removedAt: null, remindedSoonAt: null, remindedOverdueAt: null }).where(eq(courseLearners.id, e.id));
      if (e.removedAt || e.source !== "assigned") added++;
    } else {
      await deps.db.insert(courseLearners).values({ id: sortableId("lrn"), orgId: actor.orgId, docId, userId, source: "assigned", assignedBy: actor.userId || null, dueAt: due, createdAt: now }).onConflictDoNothing();
      added++;
    }
    if (userId !== actor.userId && (!e || e.removedAt || e.source !== "assigned")) {
      await notify(deps, actor.orgId, userId, { type: "course.assigned", entityType: "doc", entityId: docId, title: due ? `You have a course to do by ${due.toISOString().slice(0, 10)}: ${title}` : `You have a course to do: ${title}`, actorName: actor.name || null });
    }
  }
  await recordWrite(deps, actor, { entityType: "doc", entityId: docId, op: "update", verb: "course_assigned", data: { count: people.length } });
  return { assigned: people.length, added };
}

export async function unassign(deps: Deps, actor: SuiteActor, docId: string, learnerId: string) {
  const { meta } = await loadCourse(deps, { kind: "member", actor }, docId);
  mustBuild(actor, meta);
  const r = await deps.db.update(courseLearners).set({ removedAt: deps.now() }).where(and(eq(courseLearners.id, learnerId), eq(courseLearners.orgId, actor.orgId), eq(courseLearners.docId, docId))).returning({ id: courseLearners.id });
  if (!r.length) throw notFound("Learner");
  return { ok: true };
}

// ---------------------------------------------------------------- progress

export async function progressTable(deps: Deps, actor: SuiteActor, docId: string) {
  const { meta, title } = await loadCourse(deps, { kind: "member", actor }, docId);
  if (!canSeeProgress(actor, meta)) throw forbidden("Only admins, editors and managers of this course can see everyone's progress.");
  const lessons = await lessonsOf(deps, actor.orgId, docId);
  const learners = await deps.db.select({ l: courseLearners, name: users.name, email: users.email }).from(courseLearners).leftJoin(users, eq(users.id, courseLearners.userId))
    .where(and(eq(courseLearners.orgId, actor.orgId), eq(courseLearners.docId, docId), isNull(courseLearners.removedAt))).orderBy(asc(users.name)).limit(2000);
  const prog = await progressFor(deps, actor.orgId, learners.map((x) => x.l.id));
  const byLearner = new Map<string, (typeof prog)[number][]>();
  for (const p of prog) byLearner.set(p.learnerId, [...(byLearner.get(p.learnerId) ?? []), p]);
  const quizIds = new Set(lessons.filter((l) => l.type === "quiz").map((l) => l.id));
  const now = deps.now().getTime();
  const rows = learners.map(({ l, name, email }) => {
    const mine = byLearner.get(l.id) ?? [];
    const p = progressOf(stateOf(lessons, mine));
    const scores = mine.filter((x) => quizIds.has(x.lessonId) && x.bestScore !== null).map((x) => x.bestScore as number);
    const status = learnerStatus({ startedAt: ms(l.startedAt) ?? (mine.length ? 1 : null), completedAt: ms(l.completedAt), dueAt: ms(l.dueAt) }, now);
    return { id: l.id, userId: l.userId, name: name || email || "Someone", email: email ?? "", source: l.source, percent: l.completedAt ? 100 : p.percent, done: p.done, total: p.total, bestScore: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null, dueAt: ms(l.dueAt), completedAt: ms(l.completedAt), status, statusLabel: STATUS_LABEL[status] };
  });
  return { course: { id: docId, title }, rows, counts: { learners: rows.length, completed: rows.filter((r) => r.status === "completed").length, overdue: rows.filter((r) => r.status === "overdue").length } };
}

export async function progressCsv(deps: Deps, actor: SuiteActor, docId: string) {
  const t = await progressTable(deps, actor, docId);
  const day = (n: number | null) => (n ? new Date(n).toISOString().slice(0, 10) : "");
  const body = toCsv([["Name", "Email", "Status", "Progress %", "Lessons done", "Lessons", "Average quiz score", "Due", "Completed"], ...t.rows.map((r) => [r.name, r.email, r.statusLabel, r.percent, r.done, r.total, r.bestScore ?? "", day(r.dueAt), day(r.completedAt)])]);
  const name = t.course.title.replace(/[^\w ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "course";
  return { filename: `${name}-progress.csv`, body };
}

// ---------------------------------------------------------------- my learning

export async function myLearning(deps: Deps, actor: SuiteActor) {
  if (!actor.userId) return { items: [] };
  const rows = await deps.db.select({ l: courseLearners, title: docs.title, status: docCourses.status }).from(courseLearners)
    .innerJoin(docs, and(eq(docs.id, courseLearners.docId), eq(docs.orgId, courseLearners.orgId)))
    .innerJoin(docCourses, eq(docCourses.docId, courseLearners.docId))
    .where(and(eq(courseLearners.orgId, actor.orgId), eq(courseLearners.userId, actor.userId), isNull(courseLearners.removedAt), isNull(docs.deletedAt), eq(docs.kind, "course"))).limit(200);
  const live = rows.filter((r) => r.status === "published");
  const docIds = [...new Set(live.map((r) => r.l.docId))];
  const lessons = docIds.length ? await deps.db.select().from(courseLessons).where(and(eq(courseLessons.orgId, actor.orgId), inIds(courseLessons.docId, docIds), isNull(courseLessons.deletedAt))) : [];
  const prog = await progressFor(deps, actor.orgId, live.map((r) => r.l.id));
  const now = deps.now().getTime();
  const items = live.map(({ l, title }) => {
    const p = progressOf(stateOf(lessons.filter((x) => x.docId === l.docId), prog.filter((x) => x.learnerId === l.id)));
    const status = learnerStatus({ startedAt: ms(l.startedAt), completedAt: ms(l.completedAt), dueAt: ms(l.dueAt) }, now);
    return { courseId: l.docId, title, source: l.source, dueAt: ms(l.dueAt), completedAt: ms(l.completedAt), percent: l.completedAt ? 100 : p.percent, lessons: p.total, status, hasCertificate: !!l.completedAt && !!l.certificateNo };
  });
  const order = (x: (typeof items)[number]) => (x.status === "overdue" ? 0 : x.status === "completed" ? 3 : x.dueAt ? 1 : 2);
  items.sort((a, b) => order(a) - order(b) || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.title.localeCompare(b.title));
  return { items };
}

// ---------------------------------------------------------------- certificate

export async function certificatePdf(deps: Deps, actor: SuiteActor, docId: string, learnerId?: string) {
  const { meta, title } = await loadCourse(deps, { kind: "member", actor }, docId);
  if (!meta.certificate) throw notFound("Certificate");
  let l: LearnerRow | undefined;
  if (learnerId) {
    l = await deps.db.select().from(courseLearners).where(and(eq(courseLearners.id, learnerId), eq(courseLearners.orgId, actor.orgId), eq(courseLearners.docId, docId))).get();
    if (l && l.userId !== actor.userId && !canSeeProgress(actor, meta)) l = undefined;
  } else if (actor.userId) l = await learnerOf(deps, actor.orgId, docId, actor.userId);
  if (!l || !l.completedAt || !l.certificateNo) throw notFound("Certificate");
  const person = await deps.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, l.userId)).get();
  const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, actor.orgId)).get();
  const brand = await getBrand(deps.db, actor.orgId).catch(() => null);
  const bytes = await renderCertificate({ person: person?.name || person?.email || "Learner", course: title, workspace: org?.name || "", completedAt: l.completedAt, number: l.certificateNo, colour: brand?.primary ?? null });
  return { bytes, filename: `certificate-${l.certificateNo}.pdf` };
}

const hexRgb = (hex: string | null) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  const n = m ? parseInt(m[1], 16) : 0x2f6f4e;
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] as const;
};

/** Standard fonts carry Latin 1 only: anything else is replaced so a name never breaks the PDF. */
const latin1 = (s: string) => s.normalize("NFKC").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

export async function renderCertificate(c: { person: string; course: string; workspace: string; completedAt: Date; number: string; colour: string | null }): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin1(`Certificate: ${c.course}`));
  pdf.setProducer("Multies");
  const page = pdf.addPage([842, 595]);
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [r, g, b] = hexRgb(c.colour);
  const brand = rgb(r, g, b), ink = rgb(0.12, 0.13, 0.15), soft = rgb(0.42, 0.44, 0.48);
  page.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: brand, borderWidth: 3 });
  page.drawRectangle({ x: 24, y: 541, width: 794, height: 30, color: brand });
  const centre = (t: string, y: number, size: number, f = font, color = ink) => {
    let s = latin1(t);
    while (s.length > 3 && f.widthOfTextAtSize(s, size) > 720) s = s.slice(0, -2) + ".";
    page.drawText(s, { x: 421 - f.widthOfTextAtSize(s, size) / 2, y, size, font: f, color });
  };
  centre(c.workspace || "Certificate", 500, 16, bold, brand);
  centre("Certificate of completion", 430, 30, bold);
  centre("This is to certify that", 380, 14, font, soft);
  centre(c.person, 330, 32, bold);
  centre("has completed the course", 285, 14, font, soft);
  centre(c.course, 245, 22, bold);
  const date = c.completedAt.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  centre(`Completed on ${date}`, 180, 13);
  centre(`Certificate number ${c.number}`, 70, 10, font, soft);
  return pdf.save();
}

// ---------------------------------------------------------------- reminders (cron)

/** Due soon and overdue reminders, one of each per learner, 100 a pass. */
export async function runCourseReminders(deps: Deps) {
  if (!featureOn(deps, "coursesR129")) return { sent: 0 }; // OPS1: the platform wide value (a cron pass)
  const now = deps.now();
  const horizon = new Date(now.getTime() + 48 * 3600_000);
  const rows = await deps.db.select({ l: courseLearners, title: docs.title }).from(courseLearners)
    .innerJoin(docs, and(eq(docs.id, courseLearners.docId), eq(docs.orgId, courseLearners.orgId)))
    .where(and(sql`${courseLearners.dueAt} IS NOT NULL AND ${courseLearners.dueAt} <= ${horizon.getTime()}`, isNull(courseLearners.completedAt), isNull(courseLearners.removedAt), eq(courseLearners.source, "assigned"), isNull(docs.deletedAt),
      sql`(${courseLearners.remindedSoonAt} IS NULL OR ${courseLearners.remindedOverdueAt} IS NULL)`)).limit(100);
  const orgs = new Map<string, boolean>();
  let sent = 0;
  for (const { l, title } of rows) {
    const which = reminderDue({ dueAt: ms(l.dueAt), completedAt: ms(l.completedAt), remindedSoonAt: ms(l.remindedSoonAt), remindedOverdueAt: ms(l.remindedOverdueAt) }, now.getTime());
    if (!which) {
      // Past due and only the "soon" one missing: mark it so the row leaves the pass.
      if (l.dueAt && l.dueAt.getTime() < now.getTime() && !l.remindedSoonAt) await deps.db.update(courseLearners).set({ remindedSoonAt: now }).where(eq(courseLearners.id, l.id));
      continue;
    }
    if (!orgs.has(l.orgId)) {
      const o = await deps.db.select({ id: organizations.id, slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, l.orgId)).get();
      orgs.set(l.orgId, !!o && !isCoursesExcluded(o, deps.config.coursesExclude ?? ""));
    }
    if (!orgs.get(l.orgId)) continue;
    const day = l.dueAt ? l.dueAt.toISOString().slice(0, 10) : "";
    await deps.db.update(courseLearners).set(which === "soon" ? { remindedSoonAt: now } : { remindedOverdueAt: now, remindedSoonAt: l.remindedSoonAt ?? now }).where(eq(courseLearners.id, l.id));
    await notify(deps, l.orgId, l.userId, { type: "course.reminder", entityType: "doc", entityId: l.docId, title: which === "soon" ? `Course due ${day}: ${title}` : `Course overdue since ${day}: ${title}` });
    sent++;
  }
  return { sent };
}
