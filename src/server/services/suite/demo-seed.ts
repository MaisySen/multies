/**
 * Sample work for the demo workspace: a client project with custom statuses, tasks made from
 * the sample mail, a doc, a few deals and two automation rules. Runs once, after the mail.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Deps } from "../../context";
import { agents, messages } from "../../db/schema";
import { backfillContacts, contactIdFor, createDeal, listDeals } from "./contacts";
import { createDoc, listDocs } from "./docs";
import { createAutomation, listAutomations, RECIPES } from "./automations";
import { registerJob } from "../jobs";
import { addComment, createProject, listProjects, listTasks, createTask, createTaskFromThread, defaultProject, link, updateTask } from "./tasks";
import type { SuiteActor } from "./common";

const day = (now: number, d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);

/**
 * Runs as a background job after the demo workspace is made, so the sign-in stays fast and
 * the seed gets its own request budget. Each part checks for itself, so a retry after a
 * failure part way finishes the seed without making anything twice.
 */
registerJob("demo.seed_suite", async (deps, payload) => {
  const p = payload as { orgId: string; userId: string; email: string; name: string };
  const actor: SuiteActor = { orgId: p.orgId, userId: p.userId, email: p.email, name: p.name, role: "owner" };
  await seedDemoSuite(deps, actor, deps.now().getTime());
});

export async function seedDemoSuite(deps: Deps, actor: SuiteActor, now: number) {
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

  async function seedTasks() {
    // Tasks made from real sample threads, the way a person would with "Make task".
    const mail = await deps.db.select({ id: messages.id, from: messages.fromAddress }).from(messages)
      .where(and(eq(messages.orgId, orgId), inArray(messages.fromAddress, ["maria@blueharbor.co", "priya@seedround.vc", "jordan@lumen.dev"]), eq(messages.folder, "inbox"))).all();
    const msg = (from: string) => mail.find((m) => m.from === from)?.id;
    const maria = msg("maria@blueharbor.co");
    const priya = msg("priya@seedround.vc");
    const jordan = msg("jordan@lumen.dev");
    const fromMaria = maria ? await createTaskFromThread(deps, actor, { messageId: maria, projectId: client.id, statusId: st("In progress"), title: "Move Blue Harbor's 14 mailboxes on Friday", assignee: me, priority: "high", start: day(now, -2), due: day(now, 3), labels: ["migration", "client"] }) : null;
    if (priya) await createTaskFromThread(deps, actor, { messageId: priya, projectId: tasksProject.id, title: "Send Priya the retention numbers before Wednesday", assignee: me, priority: "medium", due: day(now, 2), labels: ["investors"] });
    if (jordan) await createTaskFromThread(deps, actor, { messageId: jordan, projectId: tasksProject.id, title: "Reply to Jordan about a referral partnership", priority: "low", due: day(now, 6) });

    const plan: { title: string; status: string; start?: number; due?: number; priority?: "low" | "medium" | "high" | "urgent"; who?: "me" | "bot"; labels?: string[]; notes?: string }[] = [
      { title: "Export Blue Harbor's Google Workspace mail", status: "Done", start: -6, due: -4, who: "me", labels: ["migration"] },
      { title: "Set up sales@ alias to reach three people", status: "Done", start: -4, due: -3, who: "bot", labels: ["aliases"] },
      { title: "Check SPF, DKIM and DMARC on blueharbor.co", status: "In progress", start: -1, due: 1, priority: "high", who: "bot", labels: ["dns"] },
      { title: "Confirm cutover time with Maria", status: "Waiting on client", start: 0, due: 2, priority: "medium", who: "me", notes: "Maria suggested Friday after 5pm AEST. Waiting for her IT contact to confirm." },
      { title: "Point MX records at MyMail", status: "This week", start: 3, due: 3, priority: "urgent", who: "me", labels: ["dns", "migration"] },
      { title: "Train the Blue Harbor team on the shared inbox", status: "This week", start: 4, due: 7, who: "me" },
      { title: "Turn on DMARC quarantine after two clean weeks", status: "Backlog", start: 14, due: 17, priority: "low", labels: ["dns"] },
      { title: "Write the case study with Maria", status: "Backlog", start: 18, due: 24, labels: ["marketing"] },
    ];
    for (const p of plan) {
      await createTask(deps, actor, {
        title: p.title, projectId: client.id, statusId: st(p.status), notes: p.notes,
        start: p.start === undefined ? null : day(now, p.start), due: p.due === undefined ? null : day(now, p.due),
        priority: p.priority ?? "none", labels: p.labels ?? [], assignee: p.who === "me" ? me : p.who === "bot" ? botAssignee : null,
      });
    }
    if (fromMaria) {
      for (const [title, done] of [["List every mailbox and alias", true], ["Check the size of each mailbox", true], ["Send the MX change steps to Maria", false]] as const) {
        const sub = await createTask(deps, actor, { title, parentId: fromMaria.id, projectId: client.id });
        if (done) await updateTask(deps, actor, sub.id, { status: "done" });
      }
      await addComment(deps, actor, fromMaria.id, "Aliases with three destinations are fine. I've told Maria nothing gets lost over the weekend: mail queues at the sender until MX updates.");
      if (bot) await addComment(deps, { ...actor, agentId: bot.id, name: bot.name }, fromMaria.id, "Checked blueharbor.co DNS: SPF includes Google today. I'll draft the new record for review before Friday.");
    }
    return fromMaria;
  }

  if (!(await listDocs(deps, orgId)).length) {
    const doc = await createDoc(deps, actor, {
      title: "Blue Harbor cutover plan", projectId: client.id,
      text: "Goal\nMove 14 people from Google Workspace to MyMail on Friday with no lost mail.\n\nBefore Friday\n- Export each mailbox and import it\n- Recreate sales@ with three destinations\n- Lower the MX TTL to 300 seconds on Wednesday\n\nOn Friday after 5pm AEST\n- Switch MX, then update SPF and DKIM\n- Send a test from each mailbox\n\nAfter\n- Watch DMARC reports for two weeks, then move to quarantine",
      links: [{ type: "project", id: client.id }, ...(fromMaria ? [{ type: "task" as const, id: fromMaria.id }] : [])],
    });
    if (fromMaria) await link(deps, orgId, { type: "task", id: fromMaria.id }, { type: "doc", id: doc.id });
    await createDoc(deps, actor, { title: "Investor update notes", text: "Retention\nMonth 3 logo retention is the number Priya asked about.\n\nTo send\n- Cohort chart\n- Churn reasons, in their own words" });
  }

  if (!(await listDeals(deps, orgId)).deals.length) {
    const mariaContact = await contactIdFor(deps, orgId, "maria@blueharbor.co");
    const jordanContact = await contactIdFor(deps, orgId, "jordan@lumen.dev");
    const priyaContact = await contactIdFor(deps, orgId, "priya@seedround.vc");
    await createDeal(deps, actor, { title: "Blue Harbor, 14 mailboxes", stage: "won", value: 2520, contactId: mariaContact, expectedClose: day(now, -1) });
    await createDeal(deps, actor, { title: "Lumen referral partnership", stage: "qualified", value: 6000, contactId: jordanContact, expectedClose: day(now, 30) });
    await createDeal(deps, actor, { title: "Seed round follow-on", stage: "proposal", value: 25000, contactId: priyaContact, expectedClose: day(now, 21) });
    await createDeal(deps, actor, { title: "Acme Corp support inbox", stage: "lead", value: 1800, expectedClose: day(now, 45) });
  }
  if ((await listAutomations(deps, orgId)).length) return;

  for (const key of ["due_reminder", "done_notify"]) {
    const r = RECIPES.find((x) => x.key === key)!;
    await createAutomation(deps, actor, { name: r.name, trigger: r.trigger, conditions: r.conditions, action: r.action, actionConfig: r.actionConfig, enabled: true });
  }
  await createAutomation(deps, actor, { name: "Mail from Blue Harbor becomes a task", trigger: "email_received", conditions: { from: "@blueharbor.co" }, action: "create_task", actionConfig: { projectId: client.id, priority: "high", dueInDays: 1 }, enabled: true });
}
