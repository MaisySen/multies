/**
 * Sample work for the demo workspace: a client project with custom statuses, tasks made from
 * the sample mail, a doc, a few deals and two automation rules. Runs once, after the mail.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { runBatch } from "../../db";
import { activity, agents, changes, domains, organizations, entityLinks, forms, meetings, messages, projects, tasks, timeEntries } from "../../db/schema";
import { backfillContacts, contactIdFor, createDeal, listDeals } from "./contacts";
import { createDoc, listDocs } from "./docs";
import { createAutomation, listAutomations, RECIPES } from "./automations";
import { enqueue, registerJob } from "../jobs";
import { addComment, createProject, listProjects, listTasks, createTaskFromThread, defaultProject, link } from "./tasks";
import { createdBy, flushWriteBuffer, parseDate, sortableId, type SuiteActor } from "./common";

const day = (now: number, d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);

/**
 * Runs as a background job after the demo workspace is made, so the sign-in stays fast and
 * the seed gets its own request budget. Each part checks for itself, so a retry after a
 * failure part way finishes the seed without making anything twice.
 */
registerJob("demo.seed_suite", async (deps, payload) => {
  const p = payload as { orgId: string; userId: string; email: string; name: string };
  const actor: SuiteActor = { orgId: p.orgId, userId: p.userId, email: p.email, name: p.name, role: "owner" };
  // A visitor can delete their sandbox while the seed is still running (the store's
  // account deletion check does exactly that). Then there is nothing left to seed, and the
  // foreign key failure that follows is not an error.
  const stillThere = async () => !!(await deps.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, p.orgId)).get());
  if (!(await stillThere())) return;
  const part = (payload as { part?: 0 | 1 | 2 }).part ?? 1;
  try {
    if (part === 0) {
      // Part 0: the two sample agents and their mail. Skipped on a retry once they exist.
      const have = await deps.db.select({ id: agents.id }).from(agents).where(eq(agents.orgId, p.orgId)).limit(1).all();
      if (!have.length) {
        const domain = await deps.db.select({ id: domains.id, name: domains.name }).from(domains).where(eq(domains.orgId, p.orgId)).get();
        if (domain) {
          const { seedDemoAgents } = await import("../demo");
          await seedDemoAgents(deps, { userId: p.userId, email: p.email, name: p.name, orgId: p.orgId, role: "owner", sessionId: "demo" }, domain, deps.now().getTime());
        }
      }
      await enqueue(deps, "demo.seed_suite", { ...p, part: 1 }, { orgId: p.orgId, maxAttempts: 3 });
      return;
    }
    // Activity and change rows from the seed go out in one batch at the end, not two inserts per item (Sentry MYMAIL-API-N).
    const writeBuffer = { activity: [] as unknown[], changes: [] as unknown[] };
    const buffered: Deps = { ...deps, writeBuffer };
    await seedDemoSuite(buffered, actor, deps.now().getTime(), part);
    await flushWriteBuffer(deps, writeBuffer);
    // The second part runs as its own job, so the next seed request picks it up.
    if (part === 1) await enqueue(deps, "demo.seed_suite", { ...p, part: 2 }, { orgId: p.orgId, maxAttempts: 3 });
  } catch (err) {
    if (!(await stillThere())) return;
    throw err;
  }
});

/**
 * Seeds in two parts so no single request does too much on the Workers Free CPU limit:
 * part 1 makes the projects and tasks, part 2 the docs, deals, automations, chat and goals.
 */
export async function seedDemoSuite(deps: Deps, actor: SuiteActor, now: number, part: 1 | 2 | "all" = "all") {
  const orgId = actor.orgId;
  await backfillContacts(deps, orgId, { force: true });
  const me = { type: "member" as const, id: actor.userId };
  const triage = await deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.orgId, orgId)).all();
  const bot = triage.find((a) => a.name === "Support triage") ?? triage[0];
  const botAssignee = bot ? { type: "agent" as const, id: bot.id } : null;

  const tasksProject = await defaultProject(deps, actor);
  const existing = (await listProjects(deps, orgId)).find((x) => x.key === "BHM");
  const client = existing ?? await createProject(deps, actor, {
    name: "Blue Harbor move", key: "BHM", color: "#14b8a6",
    statuses: [
      { name: "Backlog", category: "todo", color: "#8a8f98" },
      { name: "This week", category: "todo", color: "#3b82f6" },
      { name: "In progress", category: "doing", color: "#f59e0b" },
      { name: "Waiting on client", category: "doing", color: "#a855f7" },
      { name: "Done", category: "done", color: "#22c55e" },
    ],
  });
  const st = (name: string) => client.statuses.find((s) => s.name === name)!.id;

  const seeded = await listTasks(deps, actor, { projectId: client.id, includeSubtasks: true });
  let fromMaria = seeded.find((t) => t.title.startsWith("Move Blue Harbor")) ?? null;
  if (!seeded.length) fromMaria = await seedTasks();
  if (part === 1) return;

  async function seedTasks() {
    // Tasks made from real sample threads, the way a person would with "Make task".
    const mail = await deps.db.select({ id: messages.id, from: messages.fromAddress }).from(messages)
      .where(and(eq(messages.orgId, orgId), inArray(messages.fromAddress, ["maria@blueharbor.co", "priya@seedround.vc", "jordan@lumen.dev"]), eq(messages.folder, "inbox"))).all();
    const msg = (from: string) => mail.find((m) => m.from === from)?.id;
    const maria = msg("maria@blueharbor.co");
    const priya = msg("priya@seedround.vc");
    const jordan = msg("jordan@lumen.dev");
    const [fromMaria] = await Promise.all([
      maria ? createTaskFromThread(deps, actor, { messageId: maria, projectId: client.id, statusId: st("In progress"), title: "Move Blue Harbor's 14 mailboxes on Friday", assignee: me, priority: "high", start: day(now, -2), due: day(now, 3), labels: ["migration", "client"] }) : Promise.resolve(null),
      priya ? createTaskFromThread(deps, actor, { messageId: priya, projectId: tasksProject.id, title: "Send Priya the retention numbers before Wednesday", assignee: me, priority: "medium", due: day(now, 2), labels: ["investors"] }) : Promise.resolve(null),
      jordan ? createTaskFromThread(deps, actor, { messageId: jordan, projectId: tasksProject.id, title: "Reply to Jordan about a referral partnership", priority: "low", due: day(now, 6) }) : Promise.resolve(null),
    ]);

    const plan: { title: string; status: string; start?: number; due?: number; priority?: "low" | "medium" | "high" | "urgent"; who?: "me" | "bot"; labels?: string[]; notes?: string }[] = [
      { title: "Export Blue Harbor's Google Workspace mail", status: "Done", start: -6, due: -4, who: "me", labels: ["migration"] },
      { title: "Set up sales@ alias to reach three people", status: "Done", start: -4, due: -3, who: "bot", labels: ["aliases"] },
      { title: "Check SPF, DKIM and DMARC on blueharbor.co", status: "In progress", start: -1, due: 1, priority: "high", who: "bot", labels: ["dns"] },
      { title: "Confirm cutover time with Maria", status: "Waiting on client", start: 0, due: 2, priority: "medium", who: "me", notes: "Maria suggested Friday after 5pm AEST. Waiting for her IT contact to confirm." },
      { title: "Point MX records at Multies", status: "This week", start: 3, due: 3, priority: "urgent", who: "me", labels: ["dns", "migration"] },
      { title: "Train the Blue Harbor team on the shared inbox", status: "This week", start: 4, due: 7, who: "me" },
      { title: "Turn on DMARC quarantine after two clean weeks", status: "Backlog", start: 14, due: 17, priority: "low", labels: ["dns"] },
      { title: "Write the case study with Maria", status: "Backlog", start: 18, due: 24, labels: ["marketing"] },
    ];
    // One batch for the planned tasks (one round trip on D1) instead of a dozen queries each.
    const planIds = await insertTasks(deps, actor, client, plan.map((p) => ({
      title: p.title, statusId: st(p.status), notes: p.notes ?? "",
      start: p.start === undefined ? null : day(now, p.start), due: p.due === undefined ? null : day(now, p.due),
      priority: p.priority ?? "none", labels: p.labels ?? [], assignee: p.who === "me" ? me : p.who === "bot" ? botAssignee : null,
    })), now);
    const byTitle = (t: string) => planIds[plan.findIndex((p) => p.title === t)];
    await runBatch(deps.db, [
      ["Check SPF, DKIM and DMARC on blueharbor.co", "Point MX records at Multies"],
      ["Confirm cutover time with Maria", "Point MX records at Multies"],
      ["Point MX records at Multies", "Train the Blue Harbor team on the shared inbox"],
      ["Point MX records at Multies", "Turn on DMARC quarantine after two clean weeks"],
    ].map(([blocker, blocked]) => deps.db.insert(entityLinks).values({ orgId, fromType: "task", fromId: byTitle(blocker), toType: "task", toId: byTitle(blocked), relation: "blocks", createdAt: new Date(now) }).onConflictDoNothing()));
    if (fromMaria) {
      const subs = [["List every mailbox and alias", true], ["Check the size of each mailbox", true], ["Send the MX change steps to Maria", false]] as const;
      const done = client.statuses.find((x) => x.category === "done")!;
      const todo = client.statuses.find((x) => x.category === "todo")!;
      await insertTasks(deps, actor, client, subs.map(([title, isDone]) => ({ title, statusId: isDone ? done.id : todo.id, parentId: fromMaria!.id, priority: "none" as const, labels: [], assignee: null, notes: "", start: null, due: null })), now);
      await Promise.all([
        addComment(deps, actor, fromMaria.id, "Aliases with three destinations are fine. I've told Maria nothing gets lost over the weekend: mail queues at the sender until MX updates."),
        bot ? addComment(deps, { ...actor, agentId: bot.id, name: bot.name }, fromMaria.id, "Checked blueharbor.co DNS: SPF includes Google today. I'll draft the new record for review before Friday.") : Promise.resolve(),
      ]);
    }
    return fromMaria;
  }

  const [docsList, dealsList, autoList] = await Promise.all([listDocs(deps, orgId), listDeals(deps, orgId), listAutomations(deps, orgId)]);
  await Promise.all([seedDocs(), seedDeals(), seedAutomations(), seedRound7(deps, actor, client, now), seedRound8(deps, actor, client.id, tasksProject.id), seedRound10(deps, actor, fromMaria, now)]);

  async function seedDocs() {
  if (!docsList.length) {
    const doc = await createDoc(deps, actor, {
      title: "Blue Harbor cutover plan", projectId: client.id,
      text: "Goal\nMove 14 people from Google Workspace to Multies on Friday with no lost mail.\n\nBefore Friday\n- Export each mailbox and import it\n- Recreate sales@ with three destinations\n- Lower the MX TTL to 300 seconds on Wednesday\n\nOn Friday after 5pm AEST\n- Switch MX, then update SPF and DKIM\n- Send a test from each mailbox\n\nAfter\n- Watch DMARC reports for two weeks, then move to quarantine",
      links: [{ type: "project", id: client.id }, ...(fromMaria ? [{ type: "task" as const, id: fromMaria.id }] : [])],
    });
    if (fromMaria) await link(deps, orgId, { type: "task", id: fromMaria.id }, { type: "doc", id: doc.id });
    await createDoc(deps, actor, { title: "Investor update notes", text: "Retention\nMonth 3 logo retention is the number Priya asked about.\n\nTo send\n- Cohort chart\n- Churn reasons, in their own words" });
  }
  }

  async function seedDeals() {
    if (dealsList.deals.length) return;
    const [mariaContact, jordanContact, priyaContact] = await Promise.all(["maria@blueharbor.co", "jordan@lumen.dev", "priya@seedround.vc"].map((e) => contactIdFor(deps, orgId, e)));
    await Promise.all([
      createDeal(deps, actor, { title: "Blue Harbor, 14 mailboxes", stage: "won", value: 2520, contactId: mariaContact, expectedClose: day(now, -1) }),
      createDeal(deps, actor, { title: "Lumen referral partnership", stage: "qualified", value: 6000, contactId: jordanContact, expectedClose: day(now, 30) }),
      createDeal(deps, actor, { title: "Seed round follow-on", stage: "proposal", value: 25000, contactId: priyaContact, expectedClose: day(now, 21) }),
      createDeal(deps, actor, { title: "Acme Corp support inbox", stage: "lead", value: 1800, expectedClose: day(now, 45) }),
    ]);
  }

  async function seedAutomations() {
    if (autoList.length) return;
    await Promise.all([
      ...["due_reminder", "done_notify"].map((key) => {
        const r = RECIPES.find((x) => x.key === key)!;
        return createAutomation(deps, actor, { name: r.name, trigger: r.trigger, conditions: r.conditions, action: r.action, actionConfig: r.actionConfig, enabled: true });
      }),
      createAutomation(deps, actor, { name: "Mail from Blue Harbor becomes a task", trigger: "email_received", conditions: { from: "@blueharbor.co" }, action: "create_task", actionConfig: { projectId: client.id, priority: "high", dueInDays: 1 }, enabled: true }),
    ]);
  }
}

interface SeedTask { title: string; statusId: string; notes: string; start: string | null; due: string | null; priority: "none" | "low" | "medium" | "high" | "urgent"; labels: string[]; assignee: { type: "member" | "agent"; id: string } | null; parentId?: string }

/** Inserts tasks in one batch: numbers claimed together, then the rows, activity and change entries. */
async function insertTasks(deps: Deps, actor: SuiteActor, project: { id: string; statuses: { id: string; category: "todo" | "doing" | "done" }[] }, list: SeedTask[], now: number) {
  if (!list.length) return [];
  const claimed = await deps.db.update(projects).set({ nextNumber: sql`${projects.nextNumber} + ${list.length}` }).where(eq(projects.id, project.id)).returning({ n: projects.nextNumber });
  const first = Number(claimed[0].n) - list.length;
  const at = new Date(now);
  const ids = list.map((_, i) => sortableId("tsk", now + i));
  const stmts: PromiseLike<unknown>[] = [];
  list.forEach((t, i) => {
    const category = project.statuses.find((s) => s.id === t.statusId)?.category ?? "todo";
    stmts.push(deps.db.insert(tasks).values({
      id: ids[i], orgId: actor.orgId, projectId: project.id, number: first + i, statusId: t.statusId, status: category, title: t.title, notes: t.notes,
      assigneeType: t.assignee?.type ?? null, assigneeId: t.assignee?.id ?? null, priority: t.priority, startAt: parseDate(t.start), dueAt: parseDate(t.due),
      labels: JSON.stringify(t.labels), parentId: t.parentId ?? null, position: (i + 1) * 1024, completedAt: category === "done" ? at : null,
      ...createdBy(actor), createdAt: at, updatedAt: at,
    }));
    stmts.push(deps.db.insert(activity).values({ id: sortableId("act", now + i), orgId: actor.orgId, actorType: "member", actorId: actor.userId, actorName: actor.name, verb: "task.created", entityType: "task", entityId: ids[i], data: JSON.stringify({ title: t.title }), createdAt: at }));
    stmts.push(deps.db.insert(changes).values({ orgId: actor.orgId, entityType: "task", entityId: ids[i], op: "create", version: 1, createdAt: at }));
  });
  await runBatch(deps.db, stmts);
  return ids;
}

/** Round 7 samples: logged time, a public form and a meeting with Maria. Each checks for itself. */
async function seedRound7(deps: Deps, actor: SuiteActor, client: { id: string }, now: number) {
  const orgId = actor.orgId;
  const [hasTime, hasForm, hasMeeting, clientTasks] = await Promise.all([
    deps.db.select({ id: timeEntries.id }).from(timeEntries).where(eq(timeEntries.orgId, orgId)).limit(1).get(),
    deps.db.select({ id: forms.id }).from(forms).where(eq(forms.orgId, orgId)).limit(1).get(),
    deps.db.select({ id: meetings.id }).from(meetings).where(eq(meetings.orgId, orgId)).limit(1).get(),
    deps.db.select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.orgId, orgId), isNull(tasks.parentId))).all(),
  ]);
  const work: Promise<unknown>[] = [];
  if (!hasTime && clientTasks.length) {
    // About a working week of time on the client project, in Sydney business hours.
    const pick = (start: string) => clientTasks.find((t) => t.title.startsWith(start));
    const log: [string, number, number, string][] = [
      ["Export Blue Harbor", -6, 95, "Exported 14 mailboxes"], ["Export Blue Harbor", -5, 120, "Imported the big ones"], ["Set up sales@", -4, 25, ""],
      ["Check SPF", -2, 50, "Drafted the new SPF record"], ["Move Blue Harbor", -2, 70, "Call with Maria"], ["Move Blue Harbor", -1, 45, ""],
      ["Confirm cutover", -1, 15, "Emailed Maria's IT contact"], ["Send Priya", -3, 40, "Pulled the cohort numbers"], ["Check SPF", 0, 30, ""],
    ];
    const at = new Date(now);
    work.push(runBatch(deps.db, log.flatMap(([start, d, minutes, note], i) => {
      const t = pick(start);
      if (!t) return [];
      const day = new Date(now + d * 86_400_000);
      const startedAt = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, 30 + i * 7));
      return [deps.db.insert(timeEntries).values({ id: sortableId("tim", now + i), orgId, taskId: t.id, projectId: t.projectId, personType: "member", personId: actor.userId, startedAt, endedAt: new Date(startedAt.getTime() + minutes * 60_000), seconds: minutes * 60, note, source: i % 3 ? "timer" : "manual", ...createdBy(actor), createdAt: at, updatedAt: at })];
    })));
  }
  if (!hasForm) {
    const { createForm } = await import("./forms");
    work.push(createForm(deps, actor, { name: "Website enquiry", description: "Tell us what you need and we'll reply within one business day.", target: "task", projectId: client.id }));
  }
  if (!hasMeeting) {
    const { createMeeting } = await import("./meetings");
    const maria = await contactIdFor(deps, orgId, "maria@blueharbor.co");
    const tomorrow = new Date(now + 86_400_000);
    const startsAt = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 23, 0)).toISOString();
    work.push(createMeeting(deps, actor, { title: "Cutover check-in with Maria", startsAt, durationMin: 30, ...(maria ? { source: { type: "contact" as const, id: maria } } : { invitees: ["maria@blueharbor.co"] }) }));
  }
  await Promise.all(work);
}

/** Round 8 samples: custom fields with values on the client project, and health on the portfolio. */
async function seedRound8(deps: Deps, actor: SuiteActor, clientId: string, otherId: string) {
  const { createField, listFields, setTaskFieldValues } = await import("./fields");
  const { updateProject } = await import("./tasks");
  if ((await listFields(deps, actor.orgId, clientId)).length) return;
  const [budget, stage, approved] = await Promise.all([
    createField(deps, actor, clientId, { name: "Budget", type: "currency", position: 0 }),
    createField(deps, actor, clientId, { name: "Stage", type: "select", position: 1, options: [{ label: "Plan", color: "#3b82f6" }, { label: "Migrate", color: "#f59e0b" }, { label: "Verify", color: "#22c55e" }] }),
    createField(deps, actor, clientId, { name: "Client approved", type: "checkbox", position: 2 }),
  ]);
  const rows = await deps.db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), eq(tasks.projectId, clientId), isNull(tasks.parentId))).all();
  const plan: [string, number, number, boolean][] = [["Move Blue Harbor", 4200, 0, true], ["Export Blue Harbor", 1800, 1, true], ["Check SPF", 350, 2, false], ["Set up sales@", 120, 1, false], ["Confirm cutover", 600, 2, false]];
  await Promise.all(plan.map(([start, amount, s, ok]) => {
    const t = rows.find((r) => r.title.startsWith(start));
    return t ? setTaskFieldValues(deps, actor.orgId, { id: t.id, projectId: clientId }, { [budget.id]: amount, [stage.id]: stage.options[s].id, [approved.id]: ok }) : null;
  }));
  await Promise.all([
    updateProject(deps, actor, clientId, { health: "at_risk", healthNote: "Waiting on Maria to confirm the cutover date", ownerId: actor.userId }),
    otherId !== clientId ? updateProject(deps, actor, otherId, { health: "on_track", ownerId: actor.userId }) : null,
  ]);
}

/** A #general welcome with a task link, and one goal with key results, so chat and goals are not empty. */
async function seedRound10(deps: Deps, actor: SuiteActor, fromMaria: { id: string } | null, now: number) {
  const [{ listChannels, postMessage }, { goalTree, createGoal }] = await Promise.all([import("./chat"), import("./goals")]);
  const [channels, goals] = await Promise.all([listChannels(deps, actor), goalTree(deps, actor.orgId)]);
  const general = channels.find((c) => c.name === "general");
  const work: Promise<unknown>[] = [];
  if (general && !general.lastMessage) {
    work.push(postMessage(deps, actor, general.id, {
      body: fromMaria
        ? `Blue Harbor's move is on for Friday. Progress is on <#task:${fromMaria.id}>, and replies to Maria go out from founders@.`
        : "Blue Harbor's move is on for Friday. Replies to Maria go out from founders@.",
    }));
  }
  if (!goals.goals.length) {
    const due = new Date(now + 70 * 86_400_000).toISOString().slice(0, 10);
    work.push(createGoal(deps, actor, {
      name: "Grow repeat customers this quarter", due,
      keyResults: [
        { name: "Monthly recurring revenue", kind: "currency", start: 8000, target: 15000, current: 11200 },
        { name: "Repeat orders a month", kind: "number", start: 0, target: 40, current: 22 },
      ],
    }));
  }
  await Promise.all(work);
}
