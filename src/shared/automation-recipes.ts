/**
 * R24.4 Automation recipes: ready "when this happens, do that" rules people turn on in one click.
 * Each recipe is one or more normal automation rows (services/suite/automations.ts); the blanks are
 * the few things only the person can say (which channel, which project, which people). Turning a
 * recipe on writes the rows with conditions.recipe set to its key, so the page can show it as on.
 * Shared by the server (validation, enable) and the web app (the Recipes tab).
 */

export type RecipeCategory = "Tasks" | "Mail" | "Chat" | "Meetings" | "Sprints";
export const RECIPE_CATEGORIES: RecipeCategory[] = ["Tasks", "Mail", "Chat", "Meetings", "Sprints"];

export type RecipeTrigger = "email_received" | "status_changed" | "due_soon" | "task_created" | "assignee_changed" | "due_passed" | "meeting_ended" | "chat_message_posted";
export type RecipeAction = "create_task" | "notify" | "assign_thread" | "post_to_channel" | "assign_task" | "set_status" | "add_label" | "set_priority" | "create_subtask_checklist";

/** What the person fills in: a picker or a short text. */
export type BlankKind = "channel" | "project" | "member" | "members" | "text";
export interface RecipeBlank {
  /** The name in the enable body: { blanks: { [key]: value } }. */
  key: string;
  kind: BlankKind;
  label: string;
  /** Where the value goes in every rule of the recipe that has the field. */
  target: "conditions" | "actionConfig";
  field: string;
  placeholder?: string;
}
export interface RecipeRule { trigger: RecipeTrigger; conditions: Record<string, unknown>; action: RecipeAction; actionConfig: Record<string, unknown> }
export interface AutomationRecipe {
  key: string;
  category: RecipeCategory;
  name: string;
  description: string;
  /** A Lucide icon name. */
  icon: string;
  rules: RecipeRule[];
  blanks: RecipeBlank[];
}

const channel = (label = "Post in which channel"): RecipeBlank => ({ key: "channelId", kind: "channel", label, target: "actionConfig", field: "channelId" });
const project = (target: "conditions" | "actionConfig" = "conditions", label = "Which project"): RecipeBlank => ({ key: "projectId", kind: "project", label, target, field: "projectId" });
const rule = (trigger: RecipeTrigger, conditions: Record<string, unknown>, action: RecipeAction, actionConfig: Record<string, unknown> = {}): RecipeRule => ({ trigger, conditions, action, actionConfig });

export const AUTOMATION_RECIPES: AutomationRecipe[] = [
  // Tasks
  { key: "done_post_channel", category: "Tasks", name: "When a task is done, post in a channel", description: "Share finished work with the team as it happens.", icon: "CircleCheck",
    rules: [rule("status_changed", { toCategory: "done" }, "post_to_channel", { message: "Done: {task.ref} {task.title} ({assignee}) {task.url}" })], blanks: [channel()] },
  { key: "assigned_notify", category: "Tasks", name: "When a task is assigned, tell the assignee", description: "The new owner gets a notification right away.", icon: "UserCheck",
    rules: [rule("assignee_changed", {}, "notify", { to: "assignee" })], blanks: [] },
  { key: "review_notify_creator", category: "Tasks", name: "When a task moves to In review, tell the creator", description: "The person who asked for the work hears it is ready to check.", icon: "Eye",
    rules: [rule("status_changed", { toStatusName: "In review" }, "notify", { to: "creator" })], blanks: [] },
  { key: "urgent_post_channel", category: "Tasks", name: "When an urgent task is created, post in a channel", description: "Urgent work never sits unseen.", icon: "Siren",
    rules: [rule("task_created", { priority: "urgent" }, "post_to_channel", { message: "Urgent: {task.ref} {task.title} in {project} {task.url}" })], blanks: [channel()] },
  { key: "bug_high_post", category: "Tasks", name: "When a bug is created, make it high priority and post in a channel", description: "New bugs jump the queue and the engineers see them.", icon: "Bug",
    rules: [rule("task_created", { type: "bug" }, "set_priority", { priority: "high" }), rule("task_created", { type: "bug" }, "post_to_channel", { message: "New bug: {task.ref} {task.title} {task.url}" })], blanks: [channel("Post in which channel, for example engineering")] },
  { key: "bug_checklist", category: "Tasks", name: "When a bug is created, add a fix checklist", description: "Adds subtasks to reproduce, fix and test.", icon: "ListChecks",
    rules: [rule("task_created", { type: "bug" }, "create_subtask_checklist", { items: ["Reproduce it", "Fix it", "Test the fix"] })], blanks: [] },
  { key: "due_passed_lead", category: "Tasks", name: "When a due date passes, give the task to the project lead", description: "Late work goes to the person who owns the project.", icon: "UserCog",
    rules: [rule("due_passed", {}, "assign_task", { mode: "lead" })], blanks: [] },
  { key: "due_passed_notify", category: "Tasks", name: "When a due date passes, tell the assignee", description: "A nudge the moment a task runs late.", icon: "AlarmClock",
    rules: [rule("due_passed", {}, "notify", { to: "assignee" })], blanks: [] },
  { key: "day_before_due", category: "Tasks", name: "A day before a task is due, remind the assignee", description: "One reminder per due date, 24 hours ahead.", icon: "BellRing",
    rules: [rule("due_soon", { hoursBefore: 24 }, "notify", { to: "assignee" })], blanks: [] },
  { key: "new_task_round_robin", category: "Tasks", name: "Share new tasks in a project between people in turn", description: "Each new task goes to the next person on the list.", icon: "Repeat",
    rules: [rule("task_created", { unassigned: true }, "assign_task", { mode: "round_robin" })],
    blanks: [project(), { key: "memberIds", kind: "members", label: "Share between", target: "actionConfig", field: "memberIds" }] },
  { key: "high_notify_lead", category: "Tasks", name: "When a high priority task is created, tell the project lead", description: "The lead sees important work as it arrives.", icon: "Flag",
    rules: [rule("task_created", { priority: "high" }, "notify", { to: "lead" })], blanks: [] },
  { key: "done_notify_creator", category: "Tasks", name: "When a task is done, tell the creator", description: "Close the loop with whoever asked.", icon: "CheckCheck",
    rules: [rule("status_changed", { toCategory: "done" }, "notify", { to: "creator" })], blanks: [] },
  { key: "project_new_post", category: "Tasks", name: "When a task is added to a project, post in a channel", description: "A project channel that lists new work.", icon: "MessageSquarePlus",
    rules: [rule("task_created", {}, "post_to_channel", { message: "New in {project}: {task.ref} {task.title} {task.url}" })], blanks: [project(), channel()] },
  { key: "doing_unassigned_lead", category: "Tasks", name: "When work starts on a task with no owner, give it to the project lead", description: "Nothing in progress goes without an owner.", icon: "UserPlus",
    rules: [rule("status_changed", { toCategory: "doing", unassigned: true }, "assign_task", { mode: "lead" })], blanks: [] },
  { key: "customer_label_priority", category: "Tasks", name: "When a task labelled customer is created, make it high priority", description: "Customer work goes to the top.", icon: "Tag",
    rules: [rule("task_created", { label: "customer" }, "set_priority", { priority: "high" })], blanks: [] },
  { key: "assigned_to_member_doing", category: "Tasks", name: "When a task is assigned, move it to In progress", description: "Assigned work shows as started on the board.", icon: "Hourglass",
    rules: [rule("assignee_changed", { category: "todo" }, "set_status", { statusName: "In progress", category: "doing" })], blanks: [] },
  // Mail
  { key: "client_email_task", category: "Mail", name: "When an email from a client arrives, make a task", description: "Client mail becomes a task due tomorrow.", icon: "MailPlus",
    rules: [rule("email_received", {}, "create_task", { priority: "high", dueInDays: 1 })], blanks: [{ key: "from", kind: "text", label: "Client address or domain", placeholder: "@client.com.au", target: "conditions", field: "from" }] },
  { key: "invoice_email_notify", category: "Mail", name: "When an email mentions an invoice, tell the admins", description: "Bills reach the people who pay them.", icon: "Receipt",
    rules: [rule("email_received", { subjectContains: "invoice" }, "notify", { to: "admins" })], blanks: [] },
  { key: "email_post_channel", category: "Mail", name: "When an email from a sender arrives, post in a channel", description: "The team sees mail from an important sender.", icon: "Mails",
    rules: [rule("email_received", {}, "post_to_channel", { message: "New email from {email.from}: {email.subject}" })],
    blanks: [{ key: "from", kind: "text", label: "Sender address or domain", placeholder: "@partner.com", target: "conditions", field: "from" }, channel()] },
  { key: "urgent_email_task", category: "Mail", name: "When an email says urgent, make an urgent task", description: "Urgent mail gets a task due today.", icon: "MailWarning",
    rules: [rule("email_received", { subjectContains: "urgent" }, "create_task", { priority: "urgent", dueInDays: 1 })], blanks: [] },
  // Chat
  { key: "chat_keyword_task", category: "Chat", name: "When a chat message has a word, make a task", description: "Say the word in chat and the message becomes a task.", icon: "MessageSquareText",
    rules: [rule("chat_message_posted", { keyword: "todo" }, "create_task", {})],
    blanks: [{ key: "keyword", kind: "text", label: "The word to look for", placeholder: "todo", target: "conditions", field: "keyword" }, project("actionConfig", "Make the task in")] },
  { key: "chat_urgent_admins", category: "Chat", name: "When someone says urgent in chat, tell the admins", description: "Admins hear about it even when they are not in the channel.", icon: "MessageCircleWarning",
    rules: [rule("chat_message_posted", { keyword: "urgent" }, "notify", { to: "admins" })], blanks: [] },
  { key: "chat_incident_post", category: "Chat", name: "When a message mentions an outage, post in another channel", description: "Copies outage reports to the channel that handles them.", icon: "Megaphone",
    rules: [rule("chat_message_posted", { keyword: "outage" }, "post_to_channel", { message: "Outage report from {author} in #{channel}: {message.text}" })], blanks: [channel()] },
  // Meetings
  { key: "meeting_ended_task", category: "Meetings", name: "When a meeting ends, make a follow up task", description: "A task to send the notes and next steps.", icon: "CalendarCheck",
    rules: [rule("meeting_ended", {}, "create_task", { title: "Send notes and next steps: {meeting.title}", dueInDays: 1 })], blanks: [project("actionConfig", "Make the task in")] },
  { key: "meeting_ended_post", category: "Meetings", name: "When a meeting ends, post in a channel", description: "The team knows the meeting is over and where the notes are.", icon: "Video",
    rules: [rule("meeting_ended", {}, "post_to_channel", { message: "{meeting.title} has ended. Notes are on the meeting page." })], blanks: [channel()] },
  // Sprints
  { key: "sprint_done_post", category: "Sprints", name: "When a sprint task is done, post in a channel", description: "Track sprint progress in chat.", icon: "Rocket",
    rules: [rule("status_changed", { toCategory: "done", inSprint: true }, "post_to_channel", { message: "Sprint progress: {task.ref} {task.title} is done ({assignee})" })], blanks: [channel()] },
  { key: "sprint_late_lead", category: "Sprints", name: "When a sprint task runs late, tell the project lead", description: "The lead can rescope before the sprint ends.", icon: "TimerOff",
    rules: [rule("due_passed", { inSprint: true }, "notify", { to: "lead" })], blanks: [] },
  { key: "sprint_bug_urgent", category: "Sprints", name: "When a sprint bug is created, make it urgent", description: "Bugs inside the sprint get fixed first.", icon: "Bug",
    rules: [rule("task_created", { type: "bug", inSprint: true }, "set_priority", { priority: "urgent" })], blanks: [] },
];

export const recipeByKey = (key: string) => AUTOMATION_RECIPES.find((r) => r.key === key);

/** Fills a recipe's blanks into its rules. Throws a plain message when a blank is missing. */
export function fillRecipe(recipe: AutomationRecipe, blanks: Record<string, unknown>): RecipeRule[] {
  for (const b of recipe.blanks) {
    const v = blanks[b.key];
    const empty = v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
    if (empty) throw new Error(`Fill in: ${b.label}.`);
    if (b.kind === "members" ? !Array.isArray(v) || v.some((x) => typeof x !== "string") : typeof v !== "string") throw new Error(`Check: ${b.label}.`);
  }
  return recipe.rules.map((r) => {
    const out: RecipeRule = { trigger: r.trigger, conditions: { ...r.conditions, recipe: recipe.key }, action: r.action, actionConfig: { ...r.actionConfig } };
    for (const b of recipe.blanks) {
      const v = blanks[b.key];
      const val = typeof v === "string" ? v.trim() : v;
      // A project blank on a create_task rule picks where the task goes; on others it narrows the trigger.
      if (b.target === "actionConfig" && !(b.field in r.actionConfig) && b.kind === "project" && r.action !== "create_task") continue;
      if (b.target === "actionConfig" && b.kind === "channel" && r.action !== "post_to_channel") continue;
      if (b.target === "actionConfig" && b.kind === "members" && r.action !== "assign_task") continue;
      (b.target === "conditions" ? out.conditions : out.actionConfig)[b.field] = val;
    }
    return out;
  });
}
