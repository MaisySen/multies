/**
 * The suite in the app (cookie session): projects, tasks, docs, contacts, deals,
 * automations, notifications, phone push registration and the change feed.
 * The same services back the REST API (v1-suite.ts) and the MCP tools.
 */
import { DependencyAddBody, DependencyLagBody, RescheduleBody, ScheduleSettingsBody } from "../services/suite/dependency-schedule-r37-schema";
import { getScheduleSettings, setScheduleSettings } from "../services/suite/schedule-settings-r38"; // R38
import { rescheduleTask, scheduleCheck } from "../services/suite/dependency-schedule-r37";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAdmin, requireAuth } from "../middleware";
import { changesSince } from "../services/suite/common";
import { PageQuery, splitIds } from "./page-query-r46";
import {
  addComment, assignees, createProject, createTask, createTaskFromThread, createView, defaultProject, deleteProject, deleteTask, deleteView, updateView, getProject, listProjects, listTasks, listTasksPage, listViews,
  parseAssignee, taskDetail, updateProject, updateTask, addDependency, removeDependency, dependencyLinks, setDependencyLag,
} from "../services/suite/tasks";
import { createDoc, deleteDoc, getDoc, listDocs, updateDoc } from "../services/suite/docs";
import {
  contactDetail, createContact, createDeal, deleteContact, deleteDeal, getCompany, listCompanies, listContacts, listDeals, updateCompany, updateContact, updateDeal,
} from "../services/suite/contacts";
import { automationUsage, createAutomation, deleteAutomation, listAutomations, RECIPES, updateAutomation } from "../services/suite/automations";
import { getDelivery, getPrefs, listNotifications, markNotificationsRead, markNotificationUnread, setDelivery, setPrefs, type Prefs } from "../services/suite/notify";
import { DeliveryPatch } from "../../shared/notification-centre"; // R97
import { HttpError } from "../lib/errors";
import { markDone, markManyDone, markUndone, snooze, SNOOZE_PRESETS, TRIAGE_VIEWS } from "../services/suite/notify-triage"; // R31 triage
import { listDevices, registerDevice, unregisterDevice } from "../services/suite/push";
import {
  AutomationCreate, AutomationPatch, CommentCreate, ContactCreate, ContactPatch, DealCreate, DealPatch, DocCreate, DocPatch, ProjectCreate, ProjectPatch, PushDevice,
  TaskCreate, TaskFromEmail, TaskPatch, TaskQuery, ViewCreate, ViewPatch, TagCreate, TagPatch,
} from "./suite-schemas";
import { runDueJobs } from "../services/jobs";
import { createTag, deleteTag, listTags, updateTag } from "../services/suite/tags-r84"; // R84
import { parseFieldFilters } from "../services/suite/fields";
import { applyTaskQuery, wantsSubtasks } from "../services/suite/task-query"; // R26 (MB-86)
import { QUERY_MAX_LENGTH } from "../../shared/task-query";
import { getBoardSettings, setBoardSettings } from "../services/suite/board-settings"; // R34 (MB-186)
import { BoardPatchSchema } from "./board-schema-r34";
import { idempotency, idempotentId, sessionIdempotencyScope } from "../lib/idempotency"; // R40 (MB-201)

// R52: query schemas built once per isolate, not on every request (zod schema construction is real CPU on a warm request).
// T1G (T1-3): a search longer than 200 characters is cut to 200 like every other list search, never refused.
const SearchQ = z.string().optional().transform((v) => (v === undefined ? undefined : v.slice(0, 200)));
const Q_SUITE_1 = z.object({ q: SearchQ, projectId: z.string().optional(), linkedType: z.enum(["project", "task", "thread", "contact", "deal"]).optional(), linkedId: z.string().optional() });
const Q_SUITE_2 = z.object({ q: SearchQ, companyId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() });
const Q_SUITE_3 = z.object({ unread: z.string().optional(), category: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().max(64).optional(), view: z.enum(TRIAGE_VIEWS).optional() });
const Q_SUITE_4 = z.object({ since: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(1000).default(500) });

type TaskBody = z.infer<typeof TaskCreate> | z.infer<typeof TaskPatch>;
/** `assignee` and `assigneeId` are the same field; the mobile app sends assigneeId. */
export const assigneeOf = (b: TaskBody) => parseAssignee(b.assignee !== undefined ? b.assignee : b.assigneeId);

export function projectRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", idempotency(sessionIdempotencyScope)) // R40 (MB-201): a retried create returns the first result
    .get("/", async (c) => {
      const archived = c.req.query("archived") === "1";
      let list = await listProjects(c.var.deps, c.var.auth.orgId, { includeArchived: archived });
      // A workspace always has somewhere to put a task: the first visit makes the default project.
      if (!list.length && !archived) { await defaultProject(c.var.deps, c.var.auth); list = await listProjects(c.var.deps, c.var.auth.orgId); }
      return c.json({ projects: list });
    })
    .post("/", async (c) => c.json({ project: await createProject(c.var.deps, c.var.auth, await parseBody(c, ProjectCreate), { id: await idempotentId(c.req.raw, "prj") }) }, 201))
    .get("/:id", async (c) => c.json({ project: await getProject(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ project: await updateProject(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ProjectPatch)) }))
    .delete("/:id", requireAdmin, async (c) => c.json(await deleteProject(c.var.deps, c.var.auth, c.req.param("id"))))
    // R34 (MB-186): board swimlanes and WIP limits.
    .get("/:id/board", async (c) => c.json({ board: await getBoardSettings(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .put("/:id/board", async (c) => c.json({ board: await setBoardSettings(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, BoardPatchSchema)) }))
    // R38: working days only and strict moves for dependency dates.
    .get("/:id/schedule", async (c) => c.json({ schedule: await getScheduleSettings(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .put("/:id/schedule", async (c) => c.json({ schedule: await setScheduleSettings(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ScheduleSettingsBody)) }));
}

// R52: built once per isolate, not on every request (zod schema construction showed up in the warm /api/tasks profile).
const TaskListQuery = TaskQuery.extend({ q: z.string().max(QUERY_MAX_LENGTH).optional(), ...PageQuery });

export function taskRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", idempotency(sessionIdempotencyScope)) // R40 (MB-201)
    .get("/", async (c) => {
      const { paged, cursor, ids, ...q } = parseQuery(c, TaskListQuery);
      const fieldFilters = parseFieldFilters(c.req.query());
      // R26 (MB-86): q is the task query language (plain words still search titles and notes).
      const queryConds = q.q ? applyTaskQuery(q.q, { deps: c.var.deps, actor: c.var.auth }) : undefined;
      const filters = { ...q, q: undefined, queryConds, includeSubtasks: q.includeSubtasks === "true" || (!!q.q && wantsSubtasks(q.q)), fieldFilters, sprintId: q.sprintId === "none" ? null : q.sprintId };
      // R46 (MB-234): board, list and backlog read every page once (paged=1, then cursor), then refresh only the tasks
      // the change feed names (ids=a,b,c with the same filters).
      const pageMode = !!paged || ids !== undefined;
      const readPage = () => listTasksPage(c.var.deps, c.var.auth, { ...filters, cursor, ids: splitIds(ids) });
      if (pageMode && (cursor || ids !== undefined)) return c.json(await readPage());
      let page = pageMode ? await readPage() : null;
      const list = async () => (pageMode ? (page = await readPage()).tasks : listTasks(c.var.deps, c.var.auth, filters));
      let tasks = page ? page.tasks : await list();
      // A demo opened from the mobile app or the API has its sample seed still waiting: run it
      // here, in this request's own budget, the first time someone lists tasks.
      if (!tasks.length && !fieldFilters.length && Object.values(q).every((v) => v === undefined)) {
        // Part 0 (agents) comes first, so run up to two parts to reach the tasks.
        for (let i = 0; i < 2 && !tasks.length; i++) {
          const seeded = await runDueJobs(c.var.deps, 1, { types: ["demo.seed_suite"], orgId: c.var.auth.orgId });
          if (!seeded.ran) break;
          tasks = await list();
        }
      }
      if (page) return c.json(page);
      return c.json({ tasks });
    })
    .post("/", async (c) => {
      const b = await parseBody(c, TaskCreate);
      return c.json({ task: await createTask(c.var.deps, c.var.auth, { ...b, assignee: assigneeOf(b) }, { id: await idempotentId(c.req.raw, "tsk") }) }, 201);
    })
    .post("/from-email", async (c) => {
      const b = await parseBody(c, TaskFromEmail);
      return c.json({ task: await createTaskFromThread(c.var.deps, c.var.auth, { ...b, assignee: parseAssignee(b.assignee) }) }, 201);
    })
    .get("/assignees", async (c) => c.json({ assignees: await assignees(c.var.deps, c.var.auth.orgId) }))
    // R84: workspace tags with colours.
    .get("/tags", async (c) => c.json({ tags: await listTags(c.var.deps, c.var.auth.orgId, { counts: c.req.query("counts") === "1" }) }))
    .post("/tags", async (c) => c.json({ tag: await createTag(c.var.deps, c.var.auth, await parseBody(c, TagCreate)) }, 201))
    // R84F: renaming, recolouring and deleting a workspace tag changes every task, so admins only; anyone can add one.
    .patch("/tags/:tagId", requireAdmin, async (c) => c.json(await updateTag(c.var.deps, c.var.auth, c.req.param("tagId"), await parseBody(c, TagPatch))))
    .delete("/tags/:tagId", requireAdmin, async (c) => c.json(await deleteTag(c.var.deps, c.var.auth, c.req.param("tagId"))))
    .get("/views", async (c) => c.json({ views: await listViews(c.var.deps, c.var.auth, c.req.query("projectId")) }))
    .post("/views", async (c) => c.json({ view: await createView(c.var.deps, c.var.auth, await parseBody(c, ViewCreate)) }, 201))
    .patch("/views/:id", async (c) => c.json({ view: await updateView(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ViewPatch)) })) // R84
    .delete("/views/:id", async (c) => c.json(await deleteView(c.var.deps, c.var.auth, c.req.param("id"))))
    // R37: date clashes along "blocks" links, and moving a task with the tasks that wait on it.
    .get("/dependencies/check", async (c) => c.json(await scheduleCheck(c.var.deps, c.var.auth.orgId, c.req.query("projectId"))))
    .post("/:id/reschedule", async (c) => c.json(await rescheduleTask(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, RescheduleBody))))
    .get("/dependencies", async (c) => c.json({ links: await dependencyLinks(c.var.deps, c.var.auth.orgId, c.req.query("projectId")) }))
    .get("/:id", async (c) => c.json(await taskDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/dependencies", async (c) => { const b = await parseBody(c, DependencyAddBody); return c.json(await addDependency(c.var.deps, c.var.auth, c.req.param("id"), b.blockedBy, b.lagDays), 201); })
    // R38: lead or lag on one link.
    .patch("/:id/dependencies/:blockedBy", async (c) => c.json(await setDependencyLag(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("blockedBy"), (await parseBody(c, DependencyLagBody)).lagDays)))
    .delete("/:id/dependencies/:blockedBy", async (c) => c.json(await removeDependency(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("blockedBy"))))
    .patch("/:id", async (c) => {
      const b = await parseBody(c, TaskPatch);
      // R40 (MB-204): If-Match carries the version the client last saw (same as the body's version field).
      const ifMatch = Number((c.req.header("if-match") ?? "").replace(/[^0-9]/g, ""));
      const version = b.version ?? (ifMatch > 0 ? ifMatch : undefined);
      return c.json({ task: await updateTask(c.var.deps, c.var.auth, c.req.param("id"), { ...b, version, assignee: assigneeOf(b), assignees: b.assignees?.map((x) => parseAssignee(x)!) }) });
    })
    .delete("/:id", async (c) => c.json(await deleteTask(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/comments", async (c) => c.json({ comment: await addComment(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, CommentCreate)).body) }, 201));
}

export function docRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, Q_SUITE_1);
      return c.json({ docs: await listDocs(c.var.deps, c.var.auth.orgId, { q: q.q, projectId: q.projectId, linkedTo: q.linkedType && q.linkedId ? { type: q.linkedType, id: q.linkedId } : undefined }) });
    })
    .post("/", async (c) => c.json({ doc: await createDoc(c.var.deps, c.var.auth, await parseBody(c, DocCreate)) }, 201))
    .get("/:id", async (c) => c.json({ doc: await getDoc(c.var.deps, c.var.auth.orgId, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ doc: await updateDoc(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, DocPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteDoc(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function contactRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, Q_SUITE_2);
      return c.json(await listContacts(c.var.deps, c.var.auth.orgId, q));
    })
    .post("/", async (c) => c.json({ contact: await createContact(c.var.deps, c.var.auth, await parseBody(c, ContactCreate)) }, 201))
    .get("/:id", async (c) => c.json(await contactDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/:id", async (c) => c.json({ contact: await updateContact(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ContactPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteContact(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function companyRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ companies: await listCompanies(c.var.deps, c.var.auth.orgId, { q: c.req.query("q") }) }))
    .get("/:id", async (c) => c.json(await getCompany(c.var.deps, c.var.auth.orgId, c.req.param("id"))))
    .patch("/:id", async (c) => c.json(await updateCompany(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, z.object({ name: z.string().trim().min(1).max(120).optional(), notes: z.string().max(20_000).optional() })))));
}

export function dealRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await listDeals(c.var.deps, c.var.auth.orgId)))
    .post("/", async (c) => c.json({ deal: await createDeal(c.var.deps, c.var.auth, await parseBody(c, DealCreate)) }, 201))
    .patch("/:id", async (c) => c.json({ deal: await updateDeal(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, DealPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteDeal(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function automationRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ automations: await listAutomations(c.var.deps, c.var.auth.orgId), recipes: RECIPES, usage: await automationUsage(c.var.deps, c.var.auth.orgId) }))
    .post("/", requireAdmin, async (c) => c.json({ automation: await createAutomation(c.var.deps, c.var.auth, await parseBody(c, AutomationCreate)) }, 201))
    .patch("/:id", requireAdmin, async (c) => c.json({ automation: await updateAutomation(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, AutomationPatch)) }))
    .delete("/:id", requireAdmin, async (c) => c.json(await deleteAutomation(c.var.deps, c.var.auth, c.req.param("id"))));
}

/** R31: bodies for the triage actions (shared with v1 and MCP). */
export const NotificationIds = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });
export const SnoozeBody = z.object({ until: z.string().max(40).optional(), preset: z.enum(SNOOZE_PRESETS).optional() })
  .refine((b) => !!b.until !== !!b.preset, { message: "Send until (an ISO date and time) or a preset, not both." });

/** R97: with the notification centre off, settings answer in the old shape (no mail field). */
function stripMail(p: Prefs) {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { inApp: v.inApp, push: v.push }]));
}

export function notificationRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, Q_SUITE_3);
      return c.json(await listNotifications(c.var.deps, c.var.auth.orgId, c.var.auth.userId, { unread: q.unread === "1" || q.unread === "true", category: q.category, limit: q.limit, before: q.before, view: q.view }));
    })
    // R31 triage: done, undone, snooze (until or preset), bulk done.
    .post("/done", async (c) => c.json(await markManyDone(c.var.deps, c.var.auth.orgId, c.var.auth.userId, (await parseBody(c, NotificationIds)).ids)))
    .post("/:id/done", async (c) => c.json(await markDone(c.var.deps, c.var.auth.orgId, c.var.auth.userId, c.req.param("id"))))
    .post("/:id/undone", async (c) => c.json(await markUndone(c.var.deps, c.var.auth.orgId, c.var.auth.userId, c.req.param("id"))))
    .post("/:id/snooze", async (c) => c.json(await snooze(c.var.deps, c.var.auth.orgId, c.var.auth.userId, c.req.param("id"), await parseBody(c, SnoozeBody))))
    .post("/read", async (c) => {
      const b = await parseBody(c, z.object({ ids: z.array(z.string()).max(500).optional(), category: z.string().max(20).optional() }));
      return c.json(await markNotificationsRead(c.var.deps, c.var.auth.orgId, c.var.auth.userId, b.ids, b.category));
    })
    .post("/:id/unread", async (c) => c.json(await markNotificationUnread(c.var.deps, c.var.auth.orgId, c.var.auth.userId, c.req.param("id"))))
    // R97: `delivery` (time zone, quiet hours, digest, pause) and `mail` per category are added fields; with the
    // notification centre off the answer is exactly the old one.
    .get("/settings", async (c) => {
      const { deps, auth } = c.var;
      const settings = await getPrefs(deps, auth.orgId, auth.userId);
      if (deps.config.notificationCentre === false) return c.json({ settings: stripMail(settings) });
      return c.json({ settings, delivery: await getDelivery(deps, auth.orgId, auth.userId) });
    })
    .put("/settings", async (c) => {
      const { deps, auth } = c.var;
      const centre = deps.config.notificationCentre !== false;
      const b = await parseBody(c, z.object({
        settings: z.record(z.string(), z.object({ inApp: z.boolean().optional(), push: z.boolean().optional(), mail: z.boolean().optional() })).optional(),
        delivery: DeliveryPatch.optional(),
      }).refine((v) => !!v.settings || !!v.delivery, { message: "Send settings or delivery." }));
      if (!centre && (b.delivery || Object.values(b.settings ?? {}).some((v) => v.mail !== undefined))) throw new HttpError(422, "validation_failed", "Mail and delivery settings are not available.");
      const settings = b.settings ? await setPrefs(deps, auth.orgId, auth.userId, b.settings) : await getPrefs(deps, auth.orgId, auth.userId);
      if (!centre) return c.json({ settings: stripMail(settings) });
      const delivery = b.delivery ? await setDelivery(deps, auth.orgId, auth.userId, b.delivery) : await getDelivery(deps, auth.orgId, auth.userId);
      return c.json({ settings, delivery });
    })
}

export function pushRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/devices", async (c) => c.json({ enabled: c.var.deps.config.push.enabled, devices: await listDevices(c.var.deps, c.var.auth) }))
    .post("/devices", async (c) => c.json(await registerDevice(c.var.deps, c.var.auth, await parseBody(c, PushDevice)), 201))
    .delete("/devices/:token", async (c) => c.json(await unregisterDevice(c.var.deps, c.var.auth, decodeURIComponent(c.req.param("token")))));
}

export function changeRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, Q_SUITE_4);
      return c.json(await changesSince(c.var.deps, c.var.auth.orgId, q.since, q.limit));
    });
}
