/**
 * R129: courses API (signed in, flag COURSES_R129; vv8k and COURSES_EXCLUDE workspaces get 404).
 *   GET /api/courses (list), POST /api/courses (new course), GET /api/courses/learning (My learning)
 *   GET|PATCH /api/courses/:id, POST /api/courses/:id/lessons, PATCH|DELETE /api/courses/:id/lessons/:lid,
 *   POST /api/courses/:id/lessons/:lid/move, GET /api/courses/:id/lessons/:lid/page
 *   POST /api/courses/:id/start, POST /api/courses/:id/lessons/:lid/done, POST /api/courses/:id/lessons/:lid/quiz
 *   POST /api/courses/:id/assign, DELETE /api/courses/:id/learners/:learnerId
 *   GET /api/courses/:id/progress, GET /api/courses/:id/progress.csv, GET /api/courses/:id/certificate.pdf?learner
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import {
  assertCoursesOn, assign, certificatePdf, courseDetail, createCourse, createLesson, deleteLesson, lessonPage, listCourses, markDone, moveLesson, myLearning,
  progressCsv, progressTable, startCourse, submitQuiz, unassign, updateCourse, updateLesson,
} from "../services/courses-r129";
import { LESSON_TYPES, LIMITS, QUESTION_TYPES } from "@/shared/courses-r129";

const id = z.string().regex(/^[\w-]{1,64}$/);
const Question = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/), prompt: z.string().max(LIMITS.prompt), type: z.enum(QUESTION_TYPES),
  options: z.array(z.string().max(LIMITS.option)).max(LIMITS.options), correct: z.array(z.number().int().min(0).max(LIMITS.options)).max(LIMITS.options),
  accepted: z.array(z.string().max(LIMITS.option)).max(10),
}).strict();
const LessonFields = {
  title: z.string().max(LIMITS.title).optional(), refDocId: id.nullable().optional(), url: z.string().max(2000).nullable().optional(), body: z.string().max(LIMITS.body).optional(),
  quiz: z.array(Question).max(LIMITS.questions).optional(), passMark: z.number().int().min(0).max(100).nullable().optional(), required: z.boolean().optional(),
};
const LessonIn = z.object({ ...LessonFields, type: z.enum(LESSON_TYPES), title: z.string().max(LIMITS.title), afterId: id.nullable().optional() }).strict();
const LessonPatch = z.object({ ...LessonFields, position: z.number().finite().optional() }).strict();
const Answers = z.record(z.string().max(40), z.union([z.number().int(), z.array(z.number().int()).max(LIMITS.options), z.string().max(LIMITS.option), z.null()])).refine((o) => Object.keys(o).length <= LIMITS.questions, "Too many answers.");

export function courseRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await assertCoursesOn(c.var.deps, c.var.auth.orgId); await next(); })
    .get("/", async (c) => c.json({ courses: await listCourses(c.var.deps, c.var.auth) }))
    .post("/", async (c) => c.json({ course: await createCourse(c.var.deps, c.var.auth, await parseBody(c, z.object({ title: z.string().max(LIMITS.title).optional(), parentId: id.nullable().optional(), projectId: id.nullable().optional() }).strict())) }, 201))
    .get("/learning", async (c) => c.json(await myLearning(c.var.deps, c.var.auth)))
    .get("/:id", async (c) => c.json(await courseDetail(c.var.deps, { kind: "member", actor: c.var.auth }, c.req.param("id"))))
    .patch("/:id", async (c) => c.json(await updateCourse(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, z.object({
      status: z.enum(["draft", "published"]).optional(), passMark: z.number().int().min(0).max(100).optional(), certificate: z.boolean().optional(),
      editors: z.array(id).max(100).optional(), managers: z.array(id).max(100).optional(),
    }).strict()))))
    .post("/:id/lessons", async (c) => c.json({ lesson: await createLesson(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, LessonIn)) }, 201))
    .patch("/:id/lessons/:lid", async (c) => c.json({ lesson: await updateLesson(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("lid"), await parseBody(c, LessonPatch)) }))
    .delete("/:id/lessons/:lid", async (c) => c.json(await deleteLesson(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("lid"))))
    .post("/:id/lessons/:lid/move", async (c) => c.json(await moveLesson(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("lid"), (await parseBody(c, z.object({ dir: z.enum(["up", "down"]) }).strict())).dir)))
    .get("/:id/lessons/:lid/page", async (c) => c.json(await lessonPage(c.var.deps, { kind: "member", actor: c.var.auth }, c.req.param("id"), c.req.param("lid"))))
    .post("/:id/start", async (c) => c.json(await startCourse(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/lessons/:lid/done", async (c) => c.json(await markDone(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("lid"), (await parseBody(c, z.object({ done: z.boolean() }).strict())).done)))
    .post("/:id/lessons/:lid/quiz", async (c) => c.json(await submitQuiz(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("lid"), (await parseBody(c, z.object({ answers: Answers }).strict())).answers)))
    .post("/:id/assign", async (c) => c.json(await assign(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, z.object({ userIds: z.array(id).max(LIMITS.learnersPerAssign).optional(), everyone: z.boolean().optional(), dueAt: z.number().int().nullable().optional() }).strict()))))
    .delete("/:id/learners/:learnerId", async (c) => c.json(await unassign(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("learnerId"))))
    .get("/:id/progress", async (c) => c.json(await progressTable(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:id/progress.csv", async (c) => {
      const f = await progressCsv(c.var.deps, c.var.auth, c.req.param("id"));
      return new Response(f.body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
    })
    .get("/:id/certificate.pdf", async (c) => {
      const learner = c.req.query("learner");
      const f = await certificatePdf(c.var.deps, c.var.auth, c.req.param("id"), learner && /^[\w-]{1,64}$/.test(learner) ? learner : undefined);
      return new Response(f.bytes as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
    });
}
