/**
 * R126 People (flag PEOPLE_R126): staff directory and profiles, away ranges, onboarding and offboarding checklists that
 * become tasks, and the assets register with its history. Workspace scoped; signed in members only (never guests, portal
 * users, keys or agents); vv8k and PEOPLE_EXCLUDE answer 404. No salary or ID numbers are ever stored.
 */
import { sql } from "drizzle-orm";
import { agentInboxIdAt } from "./agents/agent-address";
import type { AuthContext, Deps } from "../context";
import { HttpError, badRequest, forbidden } from "../lib/errors";
import { newId } from "../lib/crypto";
import { createTask, updateTask } from "./suite/tasks";
import {
  ASSET_KINDS, ASSET_STATUSES, ITEM_OWNERS, MAX_ITEMS, RUN_KINDS, cleanDaysOff, cleanTags, isYmd, makesLoop, nextAssetTag, planRunTasks, toCsv,
  ASSET_KIND_LABEL, ASSET_STATUS_LABEL,
  type Asset, type AssetEvent, type AssetKind, type AssetStatus, type AwayEntry, type ItemOwner, type OnboardingTemplate, type RunKind,
  type RunProgress, type StaffPerson, type TemplateItem,
} from "../../shared/people-r126";

type A = Pick<AuthContext, "orgId" | "userId" | "email" | "name" | "role">;
type Body = Record<string, unknown>;
const nowMs = (deps: Deps) => deps.now().getTime();
const isAdmin = (a: A) => a.role === "owner" || a.role === "admin";
const notFound = () => new HttpError(404, "not_found", "Page not found.");
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\p{Cc}/gu, " ").trim().slice(0, max) : "");
const has = (b: Body, k: string) => Object.prototype.hasOwnProperty.call(b, k);
const parseJson = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
const today = (deps: Deps) => deps.now().toISOString().slice(0, 10);
const optDate = (v: unknown, label: string): string | null => {
  if (v === null || v === "" || v === undefined) return null;
  if (!isYmd(v)) throw badRequest(`${label} must be a real date.`);
  return v;
};

/** People pages stay out of the client workspace (and any listed in PEOPLE_EXCLUDE). */
export function isPeopleExcluded(org: { id: string; slug?: string | null; name?: string | null }, extra = ""): boolean {
  const hay = [org.id, org.slug ?? "", org.name ?? ""].map((s) => s.toLowerCase());
  const words = ["vv8k", ...extra.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];
  return words.some((x) => hay.some((h) => h === x || h.includes(x)));
}

export async function assertPeopleOpen(deps: Deps, a: Partial<A>): Promise<void> {
  if (!deps.config.peopleR126) throw notFound();
  if (!a.userId || !a.orgId || !a.role) throw notFound();
  const [o] = await deps.db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${a.orgId} limit 1`);
  if (!o || isPeopleExcluded(o, deps.config.peopleExclude ?? "")) throw notFound();
}

function needAdmin(a: A) { if (!isAdmin(a)) throw forbidden("Only workspace admins can do that."); }

// ---------------------------------------------------------------- staff

type StaffRow = { user_id: string; name: string; email: string; image: string | null; role: StaffPerson["role"]; title: string | null;
  team: string | null; manager_user_id: string | null; skills: string | null; start_date: string | null; location: string | null; phone: string | null; days_off: string | null };

const toPerson = (r: StaffRow): StaffPerson => ({
  userId: r.user_id, name: r.name || r.email, email: r.email, image: r.image, role: r.role, title: r.title ?? "", team: r.team ?? "",
  managerUserId: r.manager_user_id, skills: parseJson<string[]>(r.skills, []), startDate: r.start_date, location: r.location ?? "",
  phone: r.phone ?? "", daysOff: parseJson<number[]>(r.days_off, [0, 6]),
});

/** Human members of the workspace with their staff fields (agent members are not staff). */
export async function listStaff(deps: Deps, a: A): Promise<StaffPerson[]> {
  const rows = await deps.db.all<StaffRow>(sql`select m.user_id, u.name, u.email, u.image, m.role, m.title, s.team, s.manager_user_id, s.skills,
      s.start_date, s.location, s.phone, s.days_off
    from members m join users u on u.id = m.user_id
    left join staff_profiles s on s.org_id = m.organization_id and s.user_id = m.user_id
    where m.organization_id = ${a.orgId} and m.kind = 'human'
      and ${agentInboxIdAt(sql.raw("u.email"))} is null
    order by lower(u.name), u.email`);
  return rows.map(toPerson);
}

async function staffOne(deps: Deps, a: A, userId: string): Promise<StaffPerson> {
  const p = (await listStaff(deps, a)).find((x) => x.userId === userId);
  if (!p) throw notFound();
  return p;
}

export async function getProfile(deps: Deps, a: A, userId: string) {
  const all = await listStaff(deps, a);
  const person = all.find((x) => x.userId === userId);
  if (!person) throw notFound();
  const manager = person.managerUserId ? all.find((x) => x.userId === person.managerUserId) ?? null : null;
  const reports = all.filter((x) => x.managerUserId === userId).map((x) => ({ userId: x.userId, name: x.name, title: x.title }));
  const away = await listAway(deps, a, { userId });
  const runs = await listRuns(deps, a, userId);
  const assets = (await listAssets(deps, a)).filter((x) => x.assignedUserId === userId);
  return { person, manager: manager && { userId: manager.userId, name: manager.name, title: manager.title }, reports, away, runs, assets,
    canEdit: isAdmin(a) || a.userId === userId, canAdmin: isAdmin(a) };
}

/** Members edit their own title, team, skills, location, phone and days off; admins also set manager and start date, for anyone. */
export async function updateProfile(deps: Deps, a: A, userId: string, b: Body) {
  const all = await listStaff(deps, a);
  const cur = all.find((x) => x.userId === userId);
  if (!cur) throw notFound();
  const self = a.userId === userId;
  if (!self && !isAdmin(a)) throw forbidden("You can edit only your own profile.");
  if (!isAdmin(a) && (has(b, "managerUserId") || has(b, "startDate"))) throw forbidden("Only workspace admins can change manager or start date.");
  const next = { ...cur };
  if (has(b, "title")) next.title = str(b.title, 80);
  if (has(b, "team")) next.team = str(b.team, 60);
  if (has(b, "skills")) next.skills = cleanTags(b.skills);
  if (has(b, "location")) next.location = str(b.location, 80);
  if (has(b, "phone")) {
    const ph = str(b.phone, 32);
    if (ph && !/^[+()0-9 .]{4,32}$/.test(ph)) throw badRequest("Use digits, spaces and + for the phone number.");
    next.phone = ph;
  }
  if (has(b, "daysOff")) {
    next.daysOff = cleanDaysOff(b.daysOff);
    if (next.daysOff.length >= 7) throw badRequest("Keep at least one working day.");
  }
  if (has(b, "startDate")) next.startDate = optDate(b.startDate, "Start date");
  if (has(b, "managerUserId")) {
    const m = b.managerUserId === null || b.managerUserId === "" ? null : String(b.managerUserId);
    if (m && !all.some((x) => x.userId === m)) throw badRequest("Choose a manager from this workspace.");
    if (makesLoop(all, userId, m)) throw badRequest("That would make a loop: this person already manages them.");
    next.managerUserId = m;
  }
  const t = nowMs(deps);
  if (next.title !== cur.title) await deps.db.run(sql`update members set title = ${next.title || null} where organization_id = ${a.orgId} and user_id = ${userId}`);
  await deps.db.run(sql`insert into staff_profiles (org_id, user_id, team, manager_user_id, skills, start_date, location, phone, days_off, updated_by, updated_at)
    values (${a.orgId}, ${userId}, ${next.team}, ${next.managerUserId}, ${JSON.stringify(next.skills)}, ${next.startDate}, ${next.location}, ${next.phone},
      ${JSON.stringify(next.daysOff)}, ${a.userId}, ${t})
    on conflict (org_id, user_id) do update set team = excluded.team, manager_user_id = excluded.manager_user_id, skills = excluded.skills,
      start_date = excluded.start_date, location = excluded.location, phone = excluded.phone, days_off = excluded.days_off,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  return { person: await staffOne(deps, a, userId) };
}

// ---------------------------------------------------------------- away (date ranges on top of the weekly days off)

export async function listAway(deps: Deps, a: A, q: { userId?: string; from?: string; to?: string } = {}): Promise<AwayEntry[]> {
  const from = q.from && isYmd(q.from) ? q.from : "0000-01-01";
  const to = q.to && isYmd(q.to) ? q.to : "9999-12-31";
  const rows = await deps.db.all<{ id: string; user_id: string; start_date: string; end_date: string; note: string }>(sql`select id, user_id, start_date, end_date, note
    from staff_away where org_id = ${a.orgId} and end_date >= ${from} and start_date <= ${to} ${q.userId ? sql`and user_id = ${q.userId}` : sql``}
    order by start_date limit 500`);
  return rows.map((r) => ({ id: r.id, userId: r.user_id, startDate: r.start_date, endDate: r.end_date, note: r.note }));
}

export async function addAway(deps: Deps, a: A, userId: string, b: Body) {
  if (a.userId !== userId && !isAdmin(a)) throw forbidden("You can add time away only for yourself.");
  await staffOne(deps, a, userId);
  const s = optDate(b.startDate, "Start"); const e = optDate(b.endDate ?? b.startDate, "End");
  if (!s || !e) throw badRequest("Choose the first and last day away.");
  if (e < s) throw badRequest("The last day must be on or after the first day.");
  if ((Date.parse(e) - Date.parse(s)) / 86_400_000 > 366) throw badRequest("Keep time away under a year per entry.");
  const id = newId("saw");
  await deps.db.run(sql`insert into staff_away (id, org_id, user_id, start_date, end_date, note, created_by, created_at)
    values (${id}, ${a.orgId}, ${userId}, ${s}, ${e}, ${str(b.note, 120)}, ${a.userId}, ${nowMs(deps)})`);
  return { away: { id, userId, startDate: s, endDate: e, note: str(b.note, 120) } };
}

export async function deleteAway(deps: Deps, a: A, id: string) {
  const [r] = await deps.db.all<{ user_id: string }>(sql`select user_id from staff_away where id = ${id} and org_id = ${a.orgId}`);
  if (!r) throw notFound();
  if (r.user_id !== a.userId && !isAdmin(a)) throw forbidden("You can remove only your own time away.");
  await deps.db.run(sql`delete from staff_away where id = ${id} and org_id = ${a.orgId}`);
  return { ok: true };
}

// ---------------------------------------------------------------- onboarding templates and runs

function cleanItems(v: unknown): TemplateItem[] {
  if (!Array.isArray(v)) throw badRequest("Add at least one step.");
  const out: TemplateItem[] = []; const ids = new Set<string>();
  for (const raw of v.slice(0, MAX_ITEMS)) {
    const x = (raw && typeof raw === "object" ? raw : {}) as Body;
    const title = str(x.title, 140);
    if (!title) continue;
    const off = Number(x.offsetDays ?? 0);
    if (!Number.isInteger(off) || off < -60 || off > 365) throw badRequest("Days from start must be a whole number from -60 to 365.");
    const owner = (ITEM_OWNERS as readonly string[]).includes(String(x.owner)) ? (x.owner as ItemOwner) : "person";
    let id = typeof x.id === "string" && /^[a-z0-9_]{3,40}$/i.test(x.id) ? x.id : newId("obi");
    if (ids.has(id)) id = newId("obi");
    ids.add(id); out.push({ id, title, offsetDays: off, owner });
  }
  if (!out.length) throw badRequest("Add at least one step.");
  return out;
}

type TplRow = { id: string; kind: RunKind; name: string; items: string; updated_at: number };
const toTpl = (r: TplRow): OnboardingTemplate => ({ id: r.id, kind: r.kind, name: r.name, items: parseJson<TemplateItem[]>(r.items, []), updatedAt: r.updated_at });

export async function listTemplates(deps: Deps, a: A): Promise<OnboardingTemplate[]> {
  return (await deps.db.all<TplRow>(sql`select id, kind, name, items, updated_at from onboarding_templates where org_id = ${a.orgId} order by kind, lower(name) limit 200`)).map(toTpl);
}
async function tplOne(deps: Deps, a: A, id: string) {
  const [r] = await deps.db.all<TplRow>(sql`select id, kind, name, items, updated_at from onboarding_templates where id = ${id} and org_id = ${a.orgId}`);
  if (!r) throw notFound();
  return toTpl(r);
}

export async function saveTemplate(deps: Deps, a: A, b: Body, id?: string) {
  needAdmin(a);
  const name = str(b.name, 80);
  if (!name) throw badRequest("Give the checklist a name.");
  const kind = (RUN_KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as RunKind) : "onboarding";
  const items = cleanItems(b.items);
  const t = nowMs(deps);
  if (id) {
    await tplOne(deps, a, id);
    await deps.db.run(sql`update onboarding_templates set name = ${name}, kind = ${kind}, items = ${JSON.stringify(items)}, updated_at = ${t} where id = ${id} and org_id = ${a.orgId}`);
  } else {
    const [{ n }] = await deps.db.all<{ n: number }>(sql`select count(*) as n from onboarding_templates where org_id = ${a.orgId}`);
    if (n >= 100) throw badRequest("A workspace can keep up to 100 checklists.");
    id = newId("obt");
    await deps.db.run(sql`insert into onboarding_templates (id, org_id, kind, name, items, created_by, created_at, updated_at)
      values (${id}, ${a.orgId}, ${kind}, ${name}, ${JSON.stringify(items)}, ${a.userId}, ${t}, ${t})`);
  }
  return { template: await tplOne(deps, a, id) };
}

export async function deleteTemplate(deps: Deps, a: A, id: string) {
  needAdmin(a);
  await tplOne(deps, a, id);
  await deps.db.run(sql`delete from onboarding_templates where id = ${id} and org_id = ${a.orgId}`);
  return { ok: true }; // runs already assigned keep their tasks and progress
}

type RunRow = { id: string; template_id: string; kind: RunKind; name: string; start_date: string };

export async function listRuns(deps: Deps, a: A, userId: string): Promise<RunProgress[]> {
  const runs = await deps.db.all<RunRow>(sql`select id, template_id, kind, name, start_date from onboarding_runs where org_id = ${a.orgId} and user_id = ${userId} order by created_at`);
  if (!runs.length) return [];
  const links = await deps.db.all<{ run_id: string; item_id: string; task_id: string; title: string | null; status: string | null; due_at: number | null; deleted_at: number | null; number: number | null }>(sql`
    select l.run_id, l.item_id, l.task_id, t.title, t.status, t.due_at, t.deleted_at, t.number from onboarding_run_tasks l
    left join tasks t on t.id = l.task_id and t.org_id = l.org_id where l.org_id = ${a.orgId} and l.run_id in (${sql.join(runs.map((r) => sql`${r.id}`), sql`, `)})`);
  return runs.map((r) => {
    const tasks = links.filter((l) => l.run_id === r.id && l.title != null && l.deleted_at == null).map((l) => ({
      itemId: l.item_id, taskId: l.task_id, title: l.title!, due: l.due_at ? new Date(l.due_at).toISOString().slice(0, 10) : null, done: l.status === "done",
    })).sort((x, y) => String(x.due).localeCompare(String(y.due)));
    return { id: r.id, templateId: r.template_id, kind: r.kind, name: r.name, startDate: r.start_date, done: tasks.filter((t) => t.done).length, total: tasks.length, tasks };
  });
}

/**
 * Assigns a checklist to a person. Idempotent: one run per person and template, one task per checklist item. Assigning
 * again with a new date moves the due dates of open tasks, adds tasks for new items and never duplicates.
 */
export async function assignRun(deps: Deps, a: A, userId: string, b: Body) {
  needAdmin(a);
  const person = await staffOne(deps, a, userId);
  const tpl = await tplOne(deps, a, String(b.templateId ?? ""));
  const start = optDate(b.startDate ?? person.startDate ?? today(deps), "Start date")!;
  const t = nowMs(deps);
  const runId = newId("obr");
  await deps.db.run(sql`insert into onboarding_runs (id, org_id, user_id, template_id, kind, name, start_date, created_by, created_at, updated_at)
    values (${runId}, ${a.orgId}, ${userId}, ${tpl.id}, ${tpl.kind}, ${tpl.name}, ${start}, ${a.userId}, ${t}, ${t})
    on conflict (org_id, user_id, template_id) do update set start_date = excluded.start_date, name = excluded.name, updated_at = excluded.updated_at`);
  const [run] = await deps.db.all<{ id: string }>(sql`select id from onboarding_runs where org_id = ${a.orgId} and user_id = ${userId} and template_id = ${tpl.id}`);
  const links = await deps.db.all<{ item_id: string; task_id: string; status: string | null; deleted_at: number | null; title: string | null }>(sql`
    select l.item_id, l.task_id, t.status, t.deleted_at, t.title from onboarding_run_tasks l left join tasks t on t.id = l.task_id and t.org_id = l.org_id
    where l.run_id = ${run.id}`);
  const plan = planRunTasks(tpl.items, start, { person: userId, manager: person.managerUserId, assigner: a.userId });
  const actor = { orgId: a.orgId, userId: a.userId, email: a.email, name: a.name, role: a.role };
  let created = 0; let moved = 0;
  for (const p of plan) {
    const l = links.find((x) => x.item_id === p.itemId);
    if (l && l.title != null && l.deleted_at == null) {
      if (l.status !== "done") { await updateTask(deps, actor, l.task_id, { due: p.due }); moved++; }
      continue;
    }
    const task = await createTask(deps, actor, {
      title: p.title, due: p.due, assignee: { type: "member", id: p.assigneeUserId }, labels: [tpl.kind],
      notes: `${tpl.kind === "onboarding" ? "Onboarding" : "Offboarding"} for ${person.name}: /app/contacts/staff/${userId}`,
    });
    await deps.db.run(sql`insert into onboarding_run_tasks (run_id, item_id, org_id, task_id) values (${run.id}, ${p.itemId}, ${a.orgId}, ${task.id})
      on conflict (run_id, item_id) do update set task_id = excluded.task_id`);
    created++;
  }
  return { created, moved, runs: await listRuns(deps, a, userId) };
}

/** Removes the checklist from the person; its tasks stay in Tasks (nothing a person did is lost). */
export async function removeRun(deps: Deps, a: A, runId: string) {
  needAdmin(a);
  const [r] = await deps.db.all<{ id: string }>(sql`select id from onboarding_runs where id = ${runId} and org_id = ${a.orgId}`);
  if (!r) throw notFound();
  await deps.db.run(sql`delete from onboarding_run_tasks where run_id = ${runId} and org_id = ${a.orgId}`);
  await deps.db.run(sql`delete from onboarding_runs where id = ${runId} and org_id = ${a.orgId}`);
  return { ok: true };
}

// ---------------------------------------------------------------- assets

type AssetRow = { id: string; tag: string; name: string; kind: AssetKind; serial: string; purchase_date: string | null; warranty_end: string | null;
  value_cents: number | null; status: AssetStatus; assigned_user_id: string | null; assigned_name: string | null; notes: string; updated_at: number };
const toAsset = (r: AssetRow): Asset => ({ id: r.id, tag: r.tag, name: r.name, kind: r.kind, serial: r.serial, purchaseDate: r.purchase_date,
  warrantyEnd: r.warranty_end, valueCents: r.value_cents, status: r.status, assignedUserId: r.assigned_user_id, assignedName: r.assigned_name,
  notes: r.notes, updatedAt: r.updated_at });

export async function listAssets(deps: Deps, a: A): Promise<Asset[]> {
  const rows = await deps.db.all<AssetRow>(sql`select x.id, x.tag, x.name, x.kind, x.serial, x.purchase_date, x.warranty_end, x.value_cents, x.status,
      x.assigned_user_id, coalesce(nullif(u.name, ''), u.email) as assigned_name, x.notes, x.updated_at
    from assets x left join users u on u.id = x.assigned_user_id where x.org_id = ${a.orgId} order by x.tag limit 2000`);
  return rows.map(toAsset);
}
async function assetOne(deps: Deps, a: A, id: string): Promise<Asset> {
  const rows = await deps.db.all<AssetRow>(sql`select x.id, x.tag, x.name, x.kind, x.serial, x.purchase_date, x.warranty_end, x.value_cents, x.status,
      x.assigned_user_id, coalesce(nullif(u.name, ''), u.email) as assigned_name, x.notes, x.updated_at
    from assets x left join users u on u.id = x.assigned_user_id where x.id = ${id} and x.org_id = ${a.orgId}`);
  if (!rows[0]) throw notFound();
  return toAsset(rows[0]);
}

async function assetEvent(deps: Deps, a: A, assetId: string, action: string, userId: string | null, detail = "") {
  await deps.db.run(sql`insert into asset_events (id, org_id, asset_id, action, user_id, by_user_id, by_name, detail, at)
    values (${newId("ase")}, ${a.orgId}, ${assetId}, ${action}, ${userId}, ${a.userId}, ${a.name || a.email || ""}, ${detail.slice(0, 200)}, ${nowMs(deps)})`);
}

export async function getAsset(deps: Deps, a: A, id: string) {
  const asset = await assetOne(deps, a, id);
  const events = await deps.db.all<{ id: string; action: string; user_id: string | null; user_name: string | null; by_name: string; detail: string; at: number }>(sql`
    select e.id, e.action, e.user_id, coalesce(nullif(u.name, ''), u.email) as user_name, e.by_name, e.detail, e.at from asset_events e
    left join users u on u.id = e.user_id where e.asset_id = ${id} and e.org_id = ${a.orgId} order by e.at desc, e.rowid desc limit 200`);
  const history: AssetEvent[] = events.map((e) => ({ id: e.id, action: e.action, userId: e.user_id, userName: e.user_name, byName: e.by_name, detail: e.detail, at: e.at }));
  return { asset, history, canEdit: isAdmin(a) };
}

function assetFields(b: Body, cur?: Asset) {
  const name = has(b, "name") ? str(b.name, 100) : cur?.name ?? "";
  if (!name) throw badRequest("Give the asset a name.");
  const kind = has(b, "kind") ? ((ASSET_KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as AssetKind) : (() => { throw badRequest("Choose a type."); })()) : cur?.kind ?? "other";
  const value = has(b, "valueCents") ? (b.valueCents === null || b.valueCents === "" ? null : Number(b.valueCents)) : cur?.valueCents ?? null;
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 100_000_000_00)) throw badRequest("Value must be a positive amount.");
  const purchaseDate = has(b, "purchaseDate") ? optDate(b.purchaseDate, "Purchase date") : cur?.purchaseDate ?? null;
  const warrantyEnd = has(b, "warrantyEnd") ? optDate(b.warrantyEnd, "Warranty end") : cur?.warrantyEnd ?? null;
  if (purchaseDate && warrantyEnd && warrantyEnd < purchaseDate) throw badRequest("Warranty end must be after the purchase date.");
  return { name, kind, serial: has(b, "serial") ? str(b.serial, 80) : cur?.serial ?? "", purchaseDate, warrantyEnd, valueCents: value,
    notes: has(b, "notes") ? str(b.notes, 1000) : cur?.notes ?? "" };
}

export async function createAsset(deps: Deps, a: A, b: Body) {
  needAdmin(a);
  const f = assetFields(b);
  const [{ n }] = await deps.db.all<{ n: number }>(sql`select count(*) as n from assets where org_id = ${a.orgId}`);
  if (n >= 2000) throw badRequest("A workspace can keep up to 2,000 assets.");
  const tags = await deps.db.all<{ tag: string }>(sql`select tag from assets where org_id = ${a.orgId}`);
  const id = newId("ast"); const t = nowMs(deps);
  await deps.db.run(sql`insert into assets (id, org_id, tag, name, kind, serial, purchase_date, warranty_end, value_cents, status, assigned_user_id, notes, created_by, created_at, updated_at)
    values (${id}, ${a.orgId}, ${nextAssetTag(tags.map((x) => x.tag))}, ${f.name}, ${f.kind}, ${f.serial}, ${f.purchaseDate}, ${f.warrantyEnd}, ${f.valueCents},
      'in_stock', null, ${f.notes}, ${a.userId}, ${t}, ${t})`);
  await assetEvent(deps, a, id, "created", null);
  return { asset: await assetOne(deps, a, id) };
}

export async function updateAsset(deps: Deps, a: A, id: string, b: Body) {
  needAdmin(a);
  const cur = await assetOne(deps, a, id);
  const f = assetFields(b, cur);
  let status = cur.status;
  if (has(b, "status")) {
    if (!(ASSET_STATUSES as readonly string[]).includes(String(b.status))) throw badRequest("Choose a status.");
    status = b.status as AssetStatus;
  }
  let assigned = cur.assignedUserId;
  if (status === "retired" || status === "lost") assigned = null;
  await deps.db.run(sql`update assets set name = ${f.name}, kind = ${f.kind}, serial = ${f.serial}, purchase_date = ${f.purchaseDate}, warranty_end = ${f.warrantyEnd},
    value_cents = ${f.valueCents}, notes = ${f.notes}, status = ${status}, assigned_user_id = ${assigned}, updated_at = ${nowMs(deps)} where id = ${id} and org_id = ${a.orgId}`);
  if (status !== cur.status) await assetEvent(deps, a, id, "status", null, ASSET_STATUS_LABEL[status]);
  if (assigned !== cur.assignedUserId) await assetEvent(deps, a, id, "returned", cur.assignedUserId);
  const changed = (["name", "kind", "serial", "purchaseDate", "warrantyEnd", "valueCents", "notes"] as const).filter((k) => f[k] !== cur[k]);
  if (changed.length) await assetEvent(deps, a, id, "edited", null, changed.join(", "));
  return { asset: await assetOne(deps, a, id) };
}

/** Hands an asset to a person (or takes it back with userId null). Every change is a history row. */
export async function assignAsset(deps: Deps, a: A, id: string, b: Body) {
  needAdmin(a);
  const cur = await assetOne(deps, a, id);
  const to = b.userId === null || b.userId === "" || b.userId === undefined ? null : String(b.userId);
  if (to) await staffOne(deps, a, to);
  if (to && (cur.status === "retired" || cur.status === "lost")) throw badRequest("This asset is retired or lost. Change its status first.");
  if (to === cur.assignedUserId) return { asset: cur };
  const status: AssetStatus = to ? "in_use" : cur.status === "in_use" ? "in_stock" : cur.status;
  await deps.db.run(sql`update assets set assigned_user_id = ${to}, status = ${status}, updated_at = ${nowMs(deps)} where id = ${id} and org_id = ${a.orgId}`);
  if (cur.assignedUserId) await assetEvent(deps, a, id, "returned", cur.assignedUserId);
  if (to) await assetEvent(deps, a, id, "assigned", to);
  return { asset: await assetOne(deps, a, id) };
}

export async function deleteAsset(deps: Deps, a: A, id: string) {
  needAdmin(a);
  await assetOne(deps, a, id);
  await deps.db.run(sql`delete from asset_events where asset_id = ${id} and org_id = ${a.orgId}`);
  await deps.db.run(sql`delete from assets where id = ${id} and org_id = ${a.orgId}`);
  return { ok: true };
}

export async function assetsCsv(deps: Deps, a: A): Promise<string> {
  needAdmin(a);
  const list = await listAssets(deps, a);
  return toCsv([["Tag", "Name", "Type", "Serial", "Status", "Assigned to", "Purchase date", "Warranty end", "Value"],
    ...list.map((x) => [x.tag, x.name, ASSET_KIND_LABEL[x.kind], x.serial, ASSET_STATUS_LABEL[x.status], x.assignedName ?? "", x.purchaseDate ?? "",
      x.warrantyEnd ?? "", x.valueCents == null ? "" : (x.valueCents / 100).toFixed(2)])]);
}
