/** R129: the courses API: flag and exclusion, building, the doc kind, learner view without the key, server scoring,
 * completion and the certificate, assignment with notifications, reminders, the progress table and CSV, roles. */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { eq } from "drizzle-orm";
import { docs, users } from "../src/server/db/schema";
import { runCourseReminders, courseDetail } from "../src/server/services/courses-r129";

async function setup(env: Record<string, string> = { COURSES_R129: "on" }) {
  const ctx = await makeTestApp(env);
  const c = new Client(ctx.app);
  await c.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, c };
}
type T = Awaited<ReturnType<typeof setup>>;
async function mate(t: T, email = "mate-r129@example.com", name = "Mate") {
  const invite = await t.c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(t.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const u = await t.deps.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  return { m, userId: u!.id };
}
const QUIZ = [
  { id: "q1", prompt: "Where do we meet in a fire?", type: "single", options: ["Car park", "Kitchen"], correct: [0], accepted: [] },
  { id: "q2", prompt: "Which are exits?", type: "multi", options: ["Front", "Back", "Lift"], correct: [0, 1], accepted: [] },
];
async function course(t: T, publish = true) {
  const page = await t.c.post("/api/docs", { title: "Safety basics", text: "Know your exits.\nCall 000." });
  const r = await t.c.post("/api/courses", { title: "Workplace safety" });
  expect(r.status).toBe(201);
  const id = r.body.course.id as string;
  expect((await t.c.post(`/api/courses/${id}/lessons`, { type: "page", title: "Read this", refDocId: page.body.doc.id })).status).toBe(201);
  const quiz = await t.c.post(`/api/courses/${id}/lessons`, { type: "quiz", title: "Check", quiz: QUIZ });
  expect(quiz.status).toBe(201);
  if (publish) expect((await t.c.patch(`/api/courses/${id}`, { status: "published" })).status).toBe(200);
  const d = (await t.c.get(`/api/courses/${id}`)).body;
  return { id, pageId: page.body.doc.id as string, lessons: d.lessons as { id: string; type: string }[] };
}

describe("R129 courses API", () => {
  it("is off without the flag and for an excluded workspace", async () => {
    const t = await setup({});
    expect((await t.c.post("/api/courses", { title: "x" })).status).toBe(404);
    expect((await t.c.get("/api/config")).body.coursesR129).toBeFalsy();
    const x = await setup({ COURSES_R129: "on", COURSES_EXCLUDE: "acme" });
    expect((await x.c.get("/api/courses")).status).toBe(404);
    const on = await setup();
    expect((await on.c.get("/api/config")).body.coursesR129).toBe(true);
  });

  it("is a doc of kind course, and doc edits stay off its content", async () => {
    const t = await setup();
    const { id } = await course(t, false);
    const docs = (await t.c.get("/api/docs")).body.docs as { id: string; kind: string }[];
    expect(docs.find((d) => d.id === id)?.kind).toBe("course");
    expect((await t.c.patch(`/api/docs/${id}`, { text: "hello" })).status).toBe(409);
    expect((await t.c.patch(`/api/docs/${id}`, { title: "Workplace safety 2026" })).status).toBe(200);
  });

  it("checks lessons when building and keeps order", async () => {
    const t = await setup();
    const empty = (await t.c.post("/api/courses", {})).body.course.id;
    expect((await t.c.patch(`/api/courses/${empty}`, { status: "published" })).status).toBe(422);
    expect((await t.c.post(`/api/courses/${empty}/lessons`, { type: "video", title: "V", url: "javascript:alert(1)" })).status).toBe(422);
    expect((await t.c.post(`/api/courses/${empty}/lessons`, { type: "quiz", title: "Q", quiz: [{ ...QUIZ[0], correct: [] }] })).status).toBe(422);
    expect((await t.c.post(`/api/courses/${empty}/lessons`, { type: "page", title: "P", refDocId: empty })).status).toBe(422);
    const a = (await t.c.post(`/api/courses/${empty}/lessons`, { type: "text", title: "One", body: "Hello" })).body.lesson.id;
    const b = (await t.c.post(`/api/courses/${empty}/lessons`, { type: "video", title: "Two", url: "https://example.com/v" })).body.lesson.id;
    const moved = (await t.c.post(`/api/courses/${empty}/lessons/${b}/move`, { dir: "up" })).body.lessons as { id: string }[];
    expect(moved.map((l) => l.id)).toEqual([b, a]);
    expect((await t.c.del(`/api/courses/${empty}/lessons/${a}`)).status).toBe(200);
    expect((await t.c.get(`/api/courses/${empty}`)).body.lessons).toHaveLength(1);
  });

  it("gives learners the lessons without the key, and only builders can change it", async () => {
    const t = await setup();
    const draft = await course(t, false);
    const { m } = await mate(t);
    expect((await m.get(`/api/courses/${draft.id}`)).status).toBe(403);
    await t.c.patch(`/api/courses/${draft.id}`, { status: "published" });
    const view = await m.get(`/api/courses/${draft.id}`);
    expect(view.status).toBe(200);
    const text = JSON.stringify(view.body);
    expect(text).not.toContain("\"correct\"");
    expect(text).not.toContain("\"accepted\"");
    expect(view.body.course.canBuild).toBe(false);
    expect(view.body.course.editors).toBeUndefined();
    expect((await m.post(`/api/courses/${draft.id}/lessons`, { type: "text", title: "Nope" })).status).toBe(403);
    expect((await m.get(`/api/courses/${draft.id}/progress`)).status).toBe(403);
    expect((await m.post(`/api/courses/${draft.id}/assign`, { everyone: true })).status).toBe(403);
    const page = (await m.get(`/api/courses/${draft.id}/lessons/${draft.lessons[0].id}/page`)).body.page;
    expect(page.text).toContain("Know your exits.");
  });

  it("scores quizzes on the server, completes the course once and makes a certificate", async () => {
    const t = await setup();
    const k = await course(t);
    const { m } = await mate(t);
    const [page, quiz] = k.lessons;
    expect((await m.get(`/api/courses/${k.id}/certificate.pdf`)).status).toBe(404);
    expect((await m.post(`/api/courses/${k.id}/lessons/${quiz.id}/done`, { done: true })).status).toBe(422);
    await m.post(`/api/courses/${k.id}/lessons/${page.id}/done`, { done: true });
    const fail = (await m.post(`/api/courses/${k.id}/lessons/${quiz.id}/quiz`, { answers: { q1: 0, q2: [0] } })).body;
    expect(fail.result).toMatchObject({ score: 50, passed: false, wrong: ["q2"] });
    expect(JSON.stringify(fail)).not.toContain("\"correct\"");
    expect(fail.detail.me.completedAt).toBeNull();
    const pass = (await m.post(`/api/courses/${k.id}/lessons/${quiz.id}/quiz`, { answers: { q1: 0, q2: [1, 0] } })).body;
    expect(pass.result).toMatchObject({ score: 100, passed: true });
    expect(pass.detail.me.status).toBe("completed");
    expect(pass.detail.me.certificateNo).toMatch(/^C\d{6}-[0-9A-F]{8}$/);
    const again = (await m.post(`/api/courses/${k.id}/lessons/${quiz.id}/quiz`, { answers: {} })).body;
    expect(again.detail.me.certificateNo).toBe(pass.detail.me.certificateNo);
    const pdf = await t.app.request(`/api/courses/${k.id}/certificate.pdf`, { headers: { cookie: m.cookie } });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const mine = (await m.get("/api/courses/learning")).body.items;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "completed", percent: 100, hasCertificate: true });
    // Ada did not take it: no certificate, and no one else's results in her view.
    expect((await t.c.get(`/api/courses/${k.id}/certificate.pdf`)).status).toBe(404);
  });

  it("assigns with a due date, notifies, reminds once each and shows progress with CSV", async () => {
    const t = await setup();
    const k = await course(t);
    const { m, userId } = await mate(t);
    const due = Date.now() + 24 * 3600_000;
    expect((await t.c.post(`/api/courses/${k.id}/assign`, { userIds: [userId], dueAt: due })).body).toMatchObject({ assigned: 1, added: 1 });
    expect(JSON.stringify((await m.get("/api/notifications")).body)).toContain("You have a course to do");
    const mine = (await m.get("/api/courses/learning")).body.items;
    expect(mine[0]).toMatchObject({ source: "assigned", status: "not_started" });
    expect((await t.c.post(`/api/courses/${k.id}/assign`, { userIds: ["nobody-here"] })).status).toBe(422);

    expect((await runCourseReminders(t.deps)).sent).toBe(1);
    expect((await runCourseReminders(t.deps)).sent).toBe(0);
    const realNow = t.deps.now;
    t.deps.now = () => new Date(due + 3600_000);
    try {
      expect((await runCourseReminders(t.deps)).sent).toBe(1);
      expect((await runCourseReminders(t.deps)).sent).toBe(0);
    } finally { t.deps.now = realNow; }
    expect(JSON.stringify((await m.get("/api/notifications")).body)).toContain("Course overdue");

    const table = (await t.c.get(`/api/courses/${k.id}/progress`)).body;
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ name: "Mate", status: "not_started", percent: 0 });
    const csv = await t.app.request(`/api/courses/${k.id}/progress.csv`, { headers: { cookie: t.c.cookie } });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const body = await csv.text();
    expect(body.split("\r\n")[0]).toBe("Name,Email,Status,Progress %,Lessons done,Lessons,Average quiz score,Due,Completed");
    expect(body).toContain("Mate,mate-r129@example.com,Not started,0");
  });

  it("lets a course manager see progress and an editor build, set by an admin", async () => {
    const t = await setup();
    const k = await course(t);
    const a = await mate(t, "boss-r129@example.com", "Boss");
    const b = await mate(t, "editor-r129@example.com", "Ed");
    expect((await a.m.patch(`/api/courses/${k.id}`, { managers: [a.userId] })).status).toBe(403);
    expect((await t.c.patch(`/api/courses/${k.id}`, { managers: [a.userId], editors: [b.userId] })).status).toBe(200);
    expect((await a.m.get(`/api/courses/${k.id}/progress`)).status).toBe(200);
    expect((await a.m.post(`/api/courses/${k.id}/lessons`, { type: "text", title: "Nope" })).status).toBe(403);
    expect((await b.m.post(`/api/courses/${k.id}/lessons`, { type: "text", title: "Yes", body: "Hi" })).status).toBe(201);
    expect((await b.m.patch(`/api/courses/${k.id}`, { editors: [] })).status).toBe(403);
    expect((await t.c.patch(`/api/courses/${k.id}`, { editors: ["not-a-member"] })).status).toBe(422);
  });

  it("keeps guests to published courses in their project, without progress", async () => {
    const t = await setup();
    const k = await course(t);
    const orgId = (await t.deps.db.select({ orgId: docs.orgId }).from(docs).where(eq(docs.id, k.id)).get())!.orgId;
    const guest = { kind: "guest" as const, actor: { orgId, userId: "", email: "g@example.com", name: "G (guest)", role: "member" as const }, projectId: "prj_other" };
    await expect(courseDetail(t.deps, guest, k.id)).rejects.toMatchObject({ status: 404 });
  });
});
