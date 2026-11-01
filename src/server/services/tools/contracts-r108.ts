/**
 * R108 Contracts (flag CONTRACTS_R108). Standard templates live in code (src/shared/contracts-r108.ts); a workspace
 * can add its own versions of them and of any clause. Everyone in the workspace can use templates and run an
 * interview; only owners and admins add, edit or retire workspace templates and clauses. A generated contract is a
 * normal Doc with its normal sharing; reminders are normal tasks for the person who made it.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { contractClauses, contractRuns, contractTemplates, organizations } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import {
  CONTRACT_LIMITS, CONTRACT_NOTE, CLAUSE_KEY, STANDARD_CLAUSES, STANDARD_TEMPLATES, buildContract, checkAnswers, checkClauseInput, contractHtml,
  contractMarkdown, plannedReminders, slugKey, standardClause, standardTemplate, unknownPlaceholders,
  type Answers, type ClauseText, type ContractTemplateDef, type FillContext,
} from "../../../shared/contracts-r108";
import { createDoc } from "../suite/docs";
import { createTask } from "../suite/tasks";
import { markdownToDoc } from "../suite/markdown-doc";
import { sortableId, type SuiteActor } from "../suite/common";
import { startTokenJob } from "./automation";

export const canManageContracts = (auth: Pick<AuthContext, "role">) => auth.role === "owner" || auth.role === "admin";
const bad = (m: string) => new HttpError(400, "invalid_input", m);
const notFound = () => new HttpError(404, "not_found", "That template isn't here any more.");
function requireManager(auth: AuthContext) {
  if (!canManageContracts(auth)) throw new HttpError(403, "forbidden", "Only workspace admins can change contract templates and clauses.");
}
const parseJson = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; } };

export async function fillContext(deps: Deps, orgId: string): Promise<FillContext> {
  const [org] = await deps.db.select({ name: organizations.name, timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  let today = deps.now().toISOString().slice(0, 10);
  try { today = new Intl.DateTimeFormat("en-CA", { timeZone: org?.timezone || "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(deps.now()); } catch { /* keep UTC */ }
  return { workspaceName: org?.name ?? "Your business", today };
}

// ------------------------------------------------------------------------------------------- clauses
interface ClauseRow { key: string; version: number; title: string; body: string; retiredAt: Date | null; createdByName: string | null; createdAt: Date }
async function clauseRows(deps: Deps, orgId: string): Promise<ClauseRow[]> {
  return deps.db.select({ key: contractClauses.key, version: contractClauses.version, title: contractClauses.title, body: contractClauses.body, retiredAt: contractClauses.retiredAt, createdByName: contractClauses.createdByName, createdAt: contractClauses.createdAt })
    .from(contractClauses).where(eq(contractClauses.orgId, orgId)).orderBy(asc(contractClauses.key), desc(contractClauses.version)).limit(2000);
}
/** The clause text in use for each key: the newest workspace version, else the standard text. Retired keys are left out. */
export async function effectiveClauses(deps: Deps, orgId: string): Promise<{ map: Map<string, ClauseText>; retired: Set<string>; rows: ClauseRow[] }> {
  const rows = await clauseRows(deps, orgId);
  const map = new Map<string, ClauseText>(STANDARD_CLAUSES.map((c) => [c.key, { ...c, version: 0 }]));
  const retired = new Set<string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    if (r.retiredAt) { retired.add(r.key); map.delete(r.key); continue; }
    map.set(r.key, { key: r.key, title: r.title, body: r.body, version: r.version });
  }
  return { map, retired, rows };
}

export async function listClauses(deps: Deps, auth: AuthContext) {
  const { map, retired, rows } = await effectiveClauses(deps, auth.orgId);
  const keys = new Set([...STANDARD_CLAUSES.map((c) => c.key), ...rows.map((r) => r.key)]);
  const usedBy = (key: string) => STANDARD_TEMPLATES.filter((t) => t.clauses.some((c) => c.key === key)).map((t) => t.name);
  return [...keys].map((key) => {
    const versions = rows.filter((r) => r.key === key);
    const std = standardClause(key);
    const cur = map.get(key) ?? (versions[0] ? { key, title: versions[0].title, body: versions[0].body, version: versions[0].version } : std ? { ...std, version: 0 } : null);
    return {
      key, title: cur?.title ?? key, body: cur?.body ?? "", version: cur?.version ?? 0, standard: !!std, retired: retired.has(key),
      edited: versions.length > 0, usedBy: usedBy(key),
      history: [...versions.map((v) => ({ version: v.version, title: v.title, body: v.body, by: v.createdByName ?? "", at: v.createdAt.toISOString() })), ...(std ? [{ version: 0, title: std.title, body: std.body, by: "", at: null as string | null }] : [])],
    };
  }).sort((a, b) => Number(a.retired) - Number(b.retired) || a.title.localeCompare(b.title));
}

async function nextVersion(deps: Deps, orgId: string, key: string) {
  const [row] = await deps.db.select({ v: contractClauses.version }).from(contractClauses).where(and(eq(contractClauses.orgId, orgId), eq(contractClauses.key, key))).orderBy(desc(contractClauses.version)).limit(1);
  return (row?.v ?? 0) + 1;
}

/** Saves a new version of a clause (a new key when none is given). Old versions stay for the record. */
export async function saveClause(deps: Deps, auth: AuthContext, input: { key?: string; title: string; body: string }) {
  requireManager(auth);
  const why = checkClauseInput(input);
  if (why) throw bad(why);
  let key = input.key?.trim();
  const rows = await clauseRows(deps, auth.orgId);
  if (key) {
    if (!CLAUSE_KEY.test(key) || (!standardClause(key) && !rows.some((r) => r.key === key))) throw new HttpError(404, "not_found", "That clause isn't here any more.");
  } else {
    const base = slugKey(input.title);
    key = base;
    for (let i = 2; standardClause(key) || rows.some((r) => r.key === key); i++) key = `${base.slice(0, 36)}_${i}`;
  }
  const version = await nextVersion(deps, auth.orgId, key);
  const retired = rows.find((r) => r.key === key)?.retiredAt ?? null;
  await deps.db.insert(contractClauses).values({ id: sortableId("ccl"), orgId: auth.orgId, key, version, title: input.title.trim(), body: input.body.replace(/\r\n/g, "\n").trim(), retiredAt: retired, createdBy: auth.userId, createdByName: auth.name ?? auth.email, createdAt: deps.now() });
  return { key, version };
}

/** Retire (templates skip it) or bring back a clause; every version of the key follows. */
export async function setClauseRetired(deps: Deps, auth: AuthContext, key: string, retire: boolean) {
  requireManager(auth);
  const rows = await clauseRows(deps, auth.orgId);
  const std = standardClause(key);
  if (!std && !rows.some((r) => r.key === key)) throw new HttpError(404, "not_found", "That clause isn't here any more.");
  if (!rows.some((r) => r.key === key) && std) {
    if (!retire) return { key, retired: false };
    await deps.db.insert(contractClauses).values({ id: sortableId("ccl"), orgId: auth.orgId, key, version: 1, title: std.title, body: std.body, retiredAt: deps.now(), createdBy: auth.userId, createdByName: auth.name ?? auth.email, createdAt: deps.now() });
    return { key, retired: true };
  }
  await deps.db.update(contractClauses).set({ retiredAt: retire ? deps.now() : null }).where(and(eq(contractClauses.orgId, auth.orgId), eq(contractClauses.key, key)));
  return { key, retired: retire };
}

// ------------------------------------------------------------------------------------------- templates
type WsRow = typeof contractTemplates.$inferSelect;
function fromWorkspace(row: WsRow): ContractTemplateDef | null {
  const base = standardTemplate(row.baseId);
  if (!base) return null;
  const keys = parseJson<string[]>(row.clauseKeys, []);
  return { ...base, id: row.id, name: row.name, description: row.description, clauses: keys.map((k) => base.clauses.find((c) => c.key === k) ?? { key: k }) };
}
async function wsRows(deps: Deps, orgId: string) {
  return deps.db.select().from(contractTemplates).where(eq(contractTemplates.orgId, orgId)).orderBy(desc(contractTemplates.updatedAt)).limit(200);
}
export async function getTemplateDef(deps: Deps, auth: AuthContext, id: string): Promise<{ def: ContractTemplateDef; builtIn: boolean; retired: boolean; baseId: string }> {
  const std = standardTemplate(id);
  if (std) return { def: std, builtIn: true, retired: false, baseId: id };
  const [row] = await deps.db.select().from(contractTemplates).where(and(eq(contractTemplates.orgId, auth.orgId), eq(contractTemplates.id, id))).limit(1);
  const def = row ? fromWorkspace(row) : null;
  if (!row || !def || (row.retiredAt && !canManageContracts(auth))) throw notFound();
  return { def, builtIn: false, retired: !!row.retiredAt, baseId: row.baseId };
}

export async function listContractTemplates(deps: Deps, auth: AuthContext) {
  const manager = canManageContracts(auth);
  const ws = (await wsRows(deps, auth.orgId)).filter((r) => manager || !r.retiredAt);
  const summary = (d: ContractTemplateDef, extra: { builtIn: boolean; retired: boolean; baseId: string; updatedAt?: string }) => ({ id: d.id, name: d.name, description: d.description, category: d.category, questionCount: d.questions.length, clauseCount: d.clauses.length, ...extra });
  return {
    templates: [
      ...ws.map((r) => { const d = fromWorkspace(r); return d ? summary(d, { builtIn: false, retired: !!r.retiredAt, baseId: r.baseId, updatedAt: r.updatedAt.toISOString() }) : null; }).filter((x) => x != null),
      ...STANDARD_TEMPLATES.map((d) => summary(d, { builtIn: true, retired: false, baseId: d.id })),
    ],
    canManage: manager, note: CONTRACT_NOTE,
  };
}

export async function templateDetail(deps: Deps, auth: AuthContext, id: string) {
  const t = await getTemplateDef(deps, auth, id);
  const { map, retired } = await effectiveClauses(deps, auth.orgId);
  const clauses = t.def.clauses.filter((c) => map.has(c.key)).map((c) => ({ ...map.get(c.key)!, when: c.when ?? null }));
  return { template: { ...t.def, builtIn: t.builtIn, retired: t.retired, baseId: t.baseId }, clauses, skipped: t.def.clauses.filter((c) => retired.has(c.key) || !map.has(c.key)).map((c) => c.key), context: await fillContext(deps, auth.orgId), canManage: canManageContracts(auth) };
}

export async function saveContractTemplate(deps: Deps, auth: AuthContext, input: { id?: string; baseId?: string; name: string; description?: string; clauseKeys: string[] }) {
  requireManager(auth);
  const name = input.name.trim();
  if (!name) throw bad("Give the template a name.");
  if (name.length > CONTRACT_LIMITS.name) throw bad(`Keep the name under ${CONTRACT_LIMITS.name} characters.`);
  const description = (input.description ?? "").trim();
  if (description.length > CONTRACT_LIMITS.description) throw bad(`Keep the description under ${CONTRACT_LIMITS.description} characters.`);
  const keys = [...new Set(input.clauseKeys.map((k) => k.trim()).filter(Boolean))];
  if (!keys.length) throw bad("Pick at least one clause.");
  if (keys.length > CONTRACT_LIMITS.clausesPerTemplate) throw bad(`A template can have up to ${CONTRACT_LIMITS.clausesPerTemplate} clauses.`);
  const { map } = await effectiveClauses(deps, auth.orgId);
  const missing = keys.filter((k) => !map.has(k));
  if (missing.length) throw bad("One of those clauses is retired or gone. Refresh and pick again.");
  const now = deps.now();
  if (input.id) {
    const [row] = await deps.db.select().from(contractTemplates).where(and(eq(contractTemplates.orgId, auth.orgId), eq(contractTemplates.id, input.id))).limit(1);
    if (!row) throw notFound();
    await deps.db.update(contractTemplates).set({ name, description, clauseKeys: JSON.stringify(keys), updatedAt: now }).where(eq(contractTemplates.id, row.id));
    return { id: row.id, warnings: placeholderWarnings(row.baseId, keys, map) };
  }
  const baseId = input.baseId ?? "";
  if (!standardTemplate(baseId)) throw bad("Choose a standard template to start from.");
  const id = sortableId("ctp");
  await deps.db.insert(contractTemplates).values({ id, orgId: auth.orgId, baseId, name, description, clauseKeys: JSON.stringify(keys), createdBy: auth.userId, createdAt: now, updatedAt: now });
  return { id, warnings: placeholderWarnings(baseId, keys, map) };
}
function placeholderWarnings(baseId: string, keys: string[], map: Map<string, ClauseText>): string[] {
  const base = standardTemplate(baseId);
  if (!base) return [];
  const out = new Set<string>();
  for (const k of keys) for (const p of unknownPlaceholders(base, map.get(k)?.body ?? "")) out.add(p);
  return [...out];
}

export async function setTemplateRetired(deps: Deps, auth: AuthContext, id: string, retire: boolean) {
  requireManager(auth);
  if (standardTemplate(id)) throw bad("Standard templates can't be retired. Make your own version instead.");
  const [row] = await deps.db.select({ id: contractTemplates.id }).from(contractTemplates).where(and(eq(contractTemplates.orgId, auth.orgId), eq(contractTemplates.id, id))).limit(1);
  if (!row) throw notFound();
  await deps.db.update(contractTemplates).set({ retiredAt: retire ? deps.now() : null, updatedAt: deps.now() }).where(eq(contractTemplates.id, id));
  return { id, retired: retire };
}

// ------------------------------------------------------------------------------------------- generating
function cleanAnswers(def: ContractTemplateDef, raw: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const x of def.questions) { const v = raw[x.key]; if (typeof v === "string" || typeof v === "number") out[x.key] = String(v).slice(0, CONTRACT_LIMITS.longAnswer); }
  return out;
}
async function assemble(deps: Deps, auth: AuthContext, templateId: string, raw: Record<string, unknown>) {
  const { def } = await getTemplateDef(deps, auth, templateId);
  const t = await getTemplateDef(deps, auth, templateId);
  if (t.retired) throw bad("This template is retired. Bring it back or pick another one.");
  const answers = cleanAnswers(def, raw);
  const errors = checkAnswers(def, answers);
  if (Object.keys(errors).length) throw new HttpError(400, "invalid_answers", "Some answers need another look.", { errors });
  const ctx = await fillContext(deps, auth.orgId);
  const { map } = await effectiveClauses(deps, auth.orgId);
  const built = buildContract(def, map, answers, ctx);
  return { def, answers, ctx, built };
}

/** Creates the contract as a Doc (normal sharing), records the run and, if asked, adds the reminder tasks for the maker. */
export async function generateContract(deps: Deps, auth: AuthContext, input: { templateId: string; answers: Record<string, unknown>; reminders: boolean }) {
  const { def, answers, ctx, built } = await assemble(deps, auth, input.templateId, input.answers);
  const actor = auth as unknown as SuiteActor;
  const doc = await createDoc(deps, actor, { title: built.title, content: markdownToDoc(contractMarkdown(built)) });
  const tasks: { id: string; title: string; due: string }[] = [];
  if (input.reminders) {
    for (const r of plannedReminders(def, answers, ctx, built.title).filter((x) => !x.past)) {
      const task = await createTask(deps, actor, { title: r.title, due: r.due, notes: `Reminder from the contract "${built.title}". ${CONTRACT_NOTE}`, assignee: { type: "member", id: auth.userId } as never });
      tasks.push({ id: (task as { id: string }).id, title: r.title, due: r.due });
    }
  }
  const id = sortableId("crn");
  await deps.db.insert(contractRuns).values({ id, orgId: auth.orgId, templateId: def.id, title: built.title, docId: doc.id, answers: JSON.stringify(answers), clauseVersions: JSON.stringify(Object.fromEntries(built.clauses.map((c) => [c.key, c.version]))), taskIds: JSON.stringify(tasks.map((t) => t.id)), createdBy: auth.userId, createdAt: deps.now() });
  return { id, doc: { id: doc.id, title: built.title }, tasks };
}

/** Starts the PDF on the document engine; the token also opens the e-sign page (send to sign). */
export async function contractPdf(deps: Deps, auth: AuthContext, input: { templateId: string; answers: Record<string, unknown> }) {
  const { built } = await assemble(deps, auth, input.templateId, input.answers);
  const name = `${built.title.replace(/[^\w ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "contract"}.pdf`;
  return startTokenJob(deps, auth, "render", [{ name: "contract.html", type: "text/html", bytes: new TextEncoder().encode(contractHtml(built)) }], { data: "{}" }, name);
}

export async function myContracts(deps: Deps, auth: AuthContext) {
  const rows = await deps.db.select({ id: contractRuns.id, title: contractRuns.title, docId: contractRuns.docId, templateId: contractRuns.templateId, taskIds: contractRuns.taskIds, createdAt: contractRuns.createdAt })
    .from(contractRuns).where(and(eq(contractRuns.orgId, auth.orgId), eq(contractRuns.createdBy, auth.userId))).orderBy(desc(contractRuns.createdAt)).limit(20);
  return rows.map((r) => ({ id: r.id, title: r.title, docId: r.docId, templateId: r.templateId, reminders: parseJson<string[]>(r.taskIds, []).length, createdAt: r.createdAt.toISOString() }));
}
