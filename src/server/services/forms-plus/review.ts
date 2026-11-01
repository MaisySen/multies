/**
 * R93 calls for submissions: a form whose target is "review" keeps each answer as an entry. Admins (or the form's
 * maker) set a rubric, assign reviewers and shortlist. A reviewer reads and scores only the entries assigned to them;
 * with blind review on, the server removes the name, email, phone and any question marked to hide before it answers.
 */
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { inIds } from "../../lib/sql-chunks";
import type { Deps } from "../../context";
import { formSubmissions, forms, members, reviewAssignments, users } from "../../db/schema";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { sortableId, type SuiteActor } from "../suite/common";
import { managedForm, requireFormsPlus } from "./plus";
import { assignReviewers, blindAnswers, parsePlus, rubricTotal, type ReviewSetup } from "@/shared/forms-plus";
import type { LogicField } from "@/shared/form-logic";

type FormRow = typeof forms.$inferSelect;
type Assignment = typeof reviewAssignments.$inferSelect;
type Field = LogicField;

const setupOf = (f: FormRow): ReviewSetup => parsePlus(f.plus).review ?? { rubric: [], perEntry: 2, blind: true, deadline: null };

async function reviewForm(deps: Deps, actor: SuiteActor, id: string) {
  const f = await managedForm(deps, actor, id);
  if (f.target !== "review") throw new HttpError(422, "validation_failed", "This form isn't a call for submissions.");
  return f;
}

const entryTitle = (fields: Field[], answers: Record<string, string>, blind: boolean, n: number) => {
  const shown = blind ? blindAnswers(fields, answers) : answers;
  const firstText = fields.find((f) => (f.type === "text" || f.type === "select") && shown[f.id]);
  return (firstText ? shown[firstText.id] : `Entry ${n}`).slice(0, 140);
};

/** Admin view: every entry with its average score, reviews done and shortlist state. */
export async function listEntries(deps: Deps, actor: SuiteActor, formId: string, q: { state?: string; offset?: number } = {}) {
  const f = await reviewForm(deps, actor, formId);
  const fields = JSON.parse(f.fields) as Field[];
  const where = [eq(formSubmissions.formId, f.id), eq(formSubmissions.orgId, actor.orgId)];
  if (q.state === "new" || q.state === "shortlisted" || q.state === "declined") where.push(eq(formSubmissions.reviewState, q.state));
  const offset = Math.max(0, Math.min(10_000, Math.floor(q.offset ?? 0)));
  const subs = await deps.db.select().from(formSubmissions).where(and(...where)).orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id)).limit(101).offset(offset).all();
  const page = subs.slice(0, 100);
  const asg = page.length ? await deps.db.select({ a: reviewAssignments, name: users.name }).from(reviewAssignments).leftJoin(users, eq(users.id, reviewAssignments.reviewerId))
    .where(and(eq(reviewAssignments.orgId, actor.orgId), inIds(reviewAssignments.submissionId, page.map((s) => s.id)))).all() : [];
  const counts = await deps.db.select({ s: formSubmissions.reviewState, n: sql<number>`count(*)` }).from(formSubmissions).where(eq(formSubmissions.formId, f.id)).groupBy(formSubmissions.reviewState).all();
  const entries = page.map((s, i) => {
    const answers = JSON.parse(s.data) as Record<string, string>;
    const mine = asg.filter((x) => x.a.submissionId === s.id);
    const done = mine.filter((x) => x.a.status === "done" && x.a.total !== null);
    return {
      id: s.id, title: entryTitle(fields, answers, false, offset + i + 1), answers, state: s.reviewState, createdAt: s.createdAt.toISOString(),
      average: done.length ? Math.round((done.reduce((t, x) => t + Number(x.a.total), 0) / done.length) * 10) / 10 : null,
      reviews: mine.map((x) => ({ id: x.a.id, reviewerId: x.a.reviewerId, reviewer: x.name ?? "Former member", status: x.a.status, total: x.a.total, comment: x.a.comment, scores: JSON.parse(x.a.scores) as Record<string, number> })),
    };
  });
  return {
    form: { id: f.id, name: f.name, fields }, setup: setupOf(f), entries, more: subs.length > 100, offset,
    counts: Object.fromEntries(counts.map((c) => [c.s, Number(c.n)])) as Record<string, number>,
  };
}

/** Assigns each entry (or the ones given) to up to perEntry reviewers, least loaded first, never the same pair twice. */
export async function assign(deps: Deps, actor: SuiteActor, formId: string, input: { reviewerIds: string[]; submissionIds?: string[] }) {
  const f = await reviewForm(deps, actor, formId);
  const setup = setupOf(f);
  if (!setup.rubric.length) throw new HttpError(422, "validation_failed", "Add at least one scoring criterion before you assign reviewers.");
  const ids = [...new Set(input.reviewerIds)].slice(0, 50);
  if (!ids.length) throw new HttpError(422, "validation_failed", "Pick at least one reviewer.", { field: "reviewerIds" });
  const ok = await deps.db.select({ u: members.userId }).from(members).where(and(eq(members.organizationId, actor.orgId), inIds(members.userId, ids), eq(members.kind, "human"))).all();
  const valid = ids.filter((id) => ok.some((o) => o.u === id));
  if (valid.length !== ids.length) throw new HttpError(422, "validation_failed", "Reviewers must be people in this workspace.", { field: "reviewerIds" });
  const subWhere = [eq(formSubmissions.formId, f.id), eq(formSubmissions.orgId, actor.orgId)];
  if (input.submissionIds?.length) subWhere.push(inIds(formSubmissions.id, input.submissionIds.slice(0, 500)));
  const subs = await deps.db.select({ id: formSubmissions.id }).from(formSubmissions).where(and(...subWhere)).orderBy(asc(formSubmissions.createdAt)).limit(500).all();
  const existing = await deps.db.select({ entryId: reviewAssignments.submissionId, reviewerId: reviewAssignments.reviewerId }).from(reviewAssignments).where(eq(reviewAssignments.formId, f.id)).all();
  const pairs = assignReviewers(subs.map((s) => s.id), valid, setup.perEntry, existing);
  const now = deps.now();
  for (let i = 0; i < pairs.length; i += 50) {
    await deps.db.insert(reviewAssignments).values(pairs.slice(i, i + 50).map((p, j) => ({ id: sortableId("rva", now.getTime() + i + j), orgId: actor.orgId, formId: f.id, submissionId: p.entryId, reviewerId: p.reviewerId, createdAt: now }))).onConflictDoNothing();
  }
  return { assigned: pairs.length };
}

export async function unassign(deps: Deps, actor: SuiteActor, assignmentId: string) {
  await requireFormsPlus(deps, actor.orgId);
  const a = await deps.db.select().from(reviewAssignments).where(and(eq(reviewAssignments.id, assignmentId), eq(reviewAssignments.orgId, actor.orgId))).get();
  if (!a) throw notFound("Assignment");
  await reviewForm(deps, actor, a.formId);
  await deps.db.delete(reviewAssignments).where(eq(reviewAssignments.id, a.id));
  return { ok: true };
}

export async function setEntryState(deps: Deps, actor: SuiteActor, formId: string, submissionId: string, state: "new" | "shortlisted" | "declined") {
  const f = await reviewForm(deps, actor, formId);
  const r = await deps.db.update(formSubmissions).set({ reviewState: state }).where(and(eq(formSubmissions.id, submissionId), eq(formSubmissions.formId, f.id), eq(formSubmissions.orgId, actor.orgId))).returning({ id: formSubmissions.id });
  if (!r.length) throw notFound("Entry");
  return { id: submissionId, state };
}

/** What a reviewer may see of one entry: blind review removes identity on the server. */
function reviewerView(f: FormRow, a: Assignment, s: typeof formSubmissions.$inferSelect, n: number) {
  const fields = JSON.parse(f.fields) as Field[];
  const setup = setupOf(f);
  const all = JSON.parse(s.data) as Record<string, string>;
  const answers = setup.blind ? blindAnswers(fields, all) : all;
  const shownFields = fields.filter((x) => answers[x.id] !== undefined).map((x) => ({ id: x.id, label: x.label, type: x.type }));
  return {
    id: a.id, formId: f.id, call: f.name, entry: { title: entryTitle(fields, all, setup.blind, n), fields: shownFields, answers, ...(setup.blind ? {} : { createdAt: s.createdAt.toISOString() }) },
    blind: setup.blind, rubric: setup.rubric, deadline: setup.deadline, status: a.status, scores: JSON.parse(a.scores) as Record<string, number>, comment: a.comment, total: a.total,
  };
}

/** The signed in person's own review queue, across calls. */
export async function myReviews(deps: Deps, actor: SuiteActor) {
  await requireFormsPlus(deps, actor.orgId);
  const rows = await deps.db.select({ a: reviewAssignments, s: formSubmissions, f: forms }).from(reviewAssignments)
    .innerJoin(formSubmissions, eq(formSubmissions.id, reviewAssignments.submissionId))
    .innerJoin(forms, and(eq(forms.id, reviewAssignments.formId), isNull(forms.deletedAt)))
    .where(and(eq(reviewAssignments.orgId, actor.orgId), eq(reviewAssignments.reviewerId, actor.userId)))
    .orderBy(asc(reviewAssignments.status), asc(reviewAssignments.createdAt)).limit(200).all();
  return { reviews: rows.map((r, i) => reviewerView(r.f, r.a, r.s, i + 1)) };
}

async function ownAssignment(deps: Deps, actor: SuiteActor, id: string) {
  await requireFormsPlus(deps, actor.orgId);
  const r = await deps.db.select({ a: reviewAssignments, s: formSubmissions, f: forms }).from(reviewAssignments)
    .innerJoin(formSubmissions, eq(formSubmissions.id, reviewAssignments.submissionId))
    .innerJoin(forms, eq(forms.id, reviewAssignments.formId))
    .where(and(eq(reviewAssignments.id, id), eq(reviewAssignments.orgId, actor.orgId))).get();
  // Someone else's assignment answers the same as one that doesn't exist.
  if (!r || r.a.reviewerId !== actor.userId) throw notFound("Review");
  return r;
}

export async function getReview(deps: Deps, actor: SuiteActor, id: string) {
  const r = await ownAssignment(deps, actor, id);
  return { review: reviewerView(r.f, r.a, r.s, 1) };
}

export async function submitReview(deps: Deps, actor: SuiteActor, id: string, input: { scores: Record<string, unknown>; comment?: string }) {
  const r = await ownAssignment(deps, actor, id);
  const setup = setupOf(r.f);
  if (setup.deadline && deps.now().toISOString().slice(0, 10) > setup.deadline) throw forbidden("Reviews for this call closed on the deadline.");
  const t = rubricTotal(setup.rubric, input.scores ?? {});
  if ("error" in t) throw new HttpError(422, "validation_failed", t.error, { field: "scores" });
  const now = deps.now();
  const set = { status: "done" as const, scores: JSON.stringify(t.scores), comment: (input.comment ?? "").trim().slice(0, 4000), total: t.total, doneAt: now };
  await deps.db.update(reviewAssignments).set(set).where(eq(reviewAssignments.id, r.a.id));
  return { review: reviewerView(r.f, { ...r.a, ...set }, r.s, 1) };
}

const csvCell = (v: unknown) => { const s = String(v ?? ""); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };

export async function entriesCsv(deps: Deps, actor: SuiteActor, formId: string) {
  const { form, entries } = await listEntries(deps, actor, formId);
  const head = ["Entry", "State", "Average score", "Reviews done", ...form.fields.map((x) => x.label), "Sent"];
  const lines = [head, ...entries.map((e) => [e.title, e.state, e.average ?? "", `${e.reviews.filter((r) => r.status === "done").length} of ${e.reviews.length}`, ...form.fields.map((x) => e.answers[x.id] ?? ""), e.createdAt])];
  return { filename: `${form.name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40) || "call"}-entries.csv`, csv: lines.map((l) => l.map(csvCell).join(",")).join("\r\n") };
}
