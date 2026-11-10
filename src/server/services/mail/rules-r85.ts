/**
 * R85: mail rules. A person's rule watches one mailbox they can open: conditions on new mail (from, sent to, subject,
 * sender domain, has an attachment; all or any) and up to 8 actions run in order (label, move to a tab, mark read,
 * archive, star, forward, reply with a saved reply, make a task, notify). Each run is logged per rule (kept 30 days).
 *
 * Rules run on new mail delivered to a Multies address (services/suite/hooks.ts), never on spam, and never on mail a
 * connected mailbox syncs in (sync stays untouched); "Run on recent mail" applies the quiet actions to recent mail of any
 * mailbox. Sending actions are guarded: no reply to bulk or no reply senders or to the workspace's own addresses, one
 * auto reply per sender per rule a day, no forward of the workspace's own mail (loops), and at most RULE_SENDS_PER_DAY a day.
 * Every run counts against the plan's monthly automation runs, like workspace automations.
 */
import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { attachments, mailboxes, mailRuleRuns, mailRules, mailThreadLabels, members, messages, users } from "../../db/schema";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { newId } from "../../lib/crypto";
import { inIds } from "../../lib/sql-chunks";
import {
  LABEL_MAX, RULE_SENDS_PER_DAY, RULE_TEST_SCAN, RULES_MAX, SENDING_ACTIONS, ruleMatches,
  type MailRule, type MailRuleActionT, type MailRuleConditionT, type MailRuleInputT, type MailRuleRun, type RuleActionKind, type RuleMessage,
} from "@/shared/mail-rules-r85";
import { isRobotSender } from "@/shared/mail-splits";
import { assertOpen, canOpen, isPersonalOwner, personalInfo, type Need } from "../mail-access-priv1a";

export interface RuleActor { orgId: string; userId: string; role?: AuthContext["role"]; agentId?: string | null; scope?: string; email?: string; name?: string }
const DAY = 86_400_000;
export const RUN_LOG_DAYS = 30;
export const RECENT_RUN_MAX = 50;

function person(a: RuleActor) {
  if (!a.userId || a.agentId) throw new HttpError(403, "person_only", "Mail rules belong to a person. Sign in to change them.");
  return a.userId;
}
function writable(a: RuleActor) {
  if (a.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
}

type Row = typeof mailRules.$inferSelect;
function parse<T>(raw: string, fallback: T): T { try { return JSON.parse(raw) as T; } catch { return fallback; } }
function present(r: Row): MailRule {
  return {
    id: r.id, name: r.name, mailboxId: r.mailboxId, match: r.match, conditions: parse<MailRuleConditionT[]>(r.conditions, []), actions: parse<MailRuleActionT[]>(r.actions, []),
    enabled: r.enabled, position: r.position, runCount: r.runCount, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastError: r.lastError,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** PRIV1b (P43): the level each action needs on a personal mailbox (a task is never made from one). */
const ACTION_NEED: Record<RuleActionKind, Need> = { notify: "read", move_to_tab: "read", create_task: "read", label: "reply", mark_read: "reply", archive: "reply", star: "reply", forward: "send", auto_reply: "send" };
const NEED_ORDER: Need[] = ["read", "reply", "send"];
function ruleNeed(actions: MailRuleActionT[], quiet = false): Need {
  let i = 0;
  for (const x of actions) if (!(quiet && SENDING_ACTIONS.includes(x.kind))) i = Math.max(i, NEED_ORDER.indexOf(ACTION_NEED[x.kind] ?? "send"));
  return NEED_ORDER[i];
}

/** PRIV1b (P43): personal mailboxes this person owns (the workspace owner: those whose owner is unknown or left). One read. */
async function ownedPersonal(deps: Deps, a: RuleActor): Promise<string[]> {
  const rows = await deps.db.select({ id: mailboxes.id, owner: mailboxes.ownerUserId, member: members.userId }).from(mailboxes)
    .leftJoin(members, and(eq(members.userId, mailboxes.ownerUserId), eq(members.organizationId, mailboxes.orgId)))
    .where(and(eq(mailboxes.orgId, a.orgId), eq(mailboxes.personal, true)));
  return rows.filter((r) => (r.owner && r.member ? r.owner === a.userId : a.role === "owner")).map((r) => r.id);
}

/** The person's rules, plus (PRIV1b, P43) every rule anyone made on a personal mailbox they own, with its maker's name. */
export async function listRules(deps: Deps, a: RuleActor): Promise<(MailRule & { createdBy?: { userId: string; name: string } })[]> {
  const userId = person(a);
  const owned = await ownedPersonal(deps, a);
  const rows = await deps.db.select({ r: mailRules, name: users.name, email: users.email }).from(mailRules).leftJoin(users, eq(users.id, mailRules.userId))
    .where(and(eq(mailRules.orgId, a.orgId), owned.length ? or(eq(mailRules.userId, userId), inIds(mailRules.mailboxId, owned)) : eq(mailRules.userId, userId)))
    .orderBy(asc(mailRules.position), asc(mailRules.createdAt));
  return rows.map(({ r, name, email }) => (r.userId === userId ? present(r) : { ...present(r), createdBy: { userId: r.userId, name: name || email || "Someone" } }));
}

/** The caller's own rule; with `ownerToo` (PRIV1b, P43) also any rule on a personal mailbox the caller owns. */
async function own(deps: Deps, a: RuleActor, id: string, ownerToo = false) {
  const userId = person(a);
  const r = await deps.db.select().from(mailRules).where(and(eq(mailRules.id, id), eq(mailRules.orgId, a.orgId))).get();
  if (!r) throw notFound("Rule");
  if (r.userId === userId) return r;
  if (ownerToo && (await isPersonalOwner(deps.db, { userId, orgId: a.orgId, role: a.role }, r.mailboxId)) === true) return r;
  throw notFound("Rule");
}

export async function getRule(deps: Deps, a: RuleActor, id: string) { return present(await own(deps, a, id, true)); }

/** Checks the mailbox is in the person's scope and every action points at something real they can use. */
async function check(deps: Deps, a: RuleActor, scope: string[] | null, input: { mailboxId: string; actions: MailRuleActionT[] }) {
  const mb = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, a.orgId))).get();
  if (!mb || (scope && !scope.includes(mb.id))) throw notFound("Mailbox");
  // PRIV1b (P43): a rule's actions need the level they act at (label: reply, forward: send as); 403 share_level.
  const need = ruleNeed(input.actions);
  if (need !== "read") await assertOpen(deps.db, { userId: a.userId, orgId: a.orgId, role: a.role }, mb.id, need);
  const kinds = input.actions.map((x) => x.kind);
  if (new Set(kinds.filter((k) => k !== "label" && k !== "forward")).size !== kinds.filter((k) => k !== "label" && k !== "forward").length) {
    throw badRequest("Each action can be used once in a rule (labels and forwards can repeat).");
  }
  for (const act of input.actions) {
    if (act.kind === "move_to_tab") {
      const { listSplits, tabIdsOf, tabsState } = await import("./splits");
      const [st, list] = await Promise.all([tabsState(deps, a), listSplits(deps, a)]);
      if (!tabIdsOf(st.style === "off" ? "classic" : st.style, list).includes(act.tab)) throw badRequest("That tab isn't one of your Inbox tabs.");
    }
    if (act.kind === "auto_reply") {
      const { getSnippet } = await import("../suite/snippets");
      await getSnippet(deps, { orgId: a.orgId, userId: a.userId, email: a.email ?? "", name: a.name ?? "", role: a.role }, act.snippetId);
    }
    if (act.kind === "forward") {
      const self = await deps.db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, input.mailboxId)).get();
      if (self && self.address.toLowerCase() === act.to.toLowerCase()) throw badRequest("Forward to another address, not this mailbox.");
    }
  }
}

export async function createRule(deps: Deps, a: RuleActor, scope: string[] | null, input: MailRuleInputT) {
  writable(a);
  const userId = person(a);
  const count = await deps.db.select({ n: sql<number>`count(*)` }).from(mailRules).where(and(eq(mailRules.orgId, a.orgId), eq(mailRules.userId, userId))).get();
  if (Number(count?.n ?? 0) >= RULES_MAX) throw badRequest(`You can have up to ${RULES_MAX} mail rules.`);
  await check(deps, a, scope, input);
  const now = deps.now();
  const id = newId("mrl");
  await deps.db.insert(mailRules).values({
    id, orgId: a.orgId, userId, mailboxId: input.mailboxId, name: input.name.trim(), match: input.match ?? "all",
    conditions: JSON.stringify(input.conditions), actions: JSON.stringify(input.actions), enabled: input.enabled ?? true,
    position: Number(count?.n ?? 0), createdAt: now, updatedAt: now,
  });
  return getRule(deps, a, id);
}

export async function updateRule(deps: Deps, a: RuleActor, scope: string[] | null, id: string, patch: Partial<MailRuleInputT>) {
  writable(a);
  const r = present(await own(deps, a, id));
  const next = { mailboxId: patch.mailboxId ?? r.mailboxId, actions: patch.actions ?? r.actions };
  if (patch.mailboxId !== undefined || patch.actions !== undefined) await check(deps, a, scope, next);
  await deps.db.update(mailRules).set({
    ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
    ...(patch.mailboxId !== undefined ? { mailboxId: patch.mailboxId } : {}),
    ...(patch.match !== undefined ? { match: patch.match } : {}),
    ...(patch.conditions !== undefined ? { conditions: JSON.stringify(patch.conditions) } : {}),
    ...(patch.actions !== undefined ? { actions: JSON.stringify(patch.actions) } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled, ...(patch.enabled ? { lastError: null } : {}) } : {}),
    updatedAt: deps.now(),
  }).where(eq(mailRules.id, id));
  return getRule(deps, a, id);
}

export async function deleteRule(deps: Deps, a: RuleActor, id: string) {
  writable(a);
  await own(deps, a, id, true);
  await deps.db.delete(mailRuleRuns).where(eq(mailRuleRuns.ruleId, id));
  await deps.db.delete(mailRules).where(eq(mailRules.id, id));
  return { deleted: true };
}

export async function listRuns(deps: Deps, a: RuleActor, id: string, limit = 50): Promise<MailRuleRun[]> {
  await own(deps, a, id, true);
  const rows = await deps.db.select().from(mailRuleRuns).where(eq(mailRuleRuns.ruleId, id)).orderBy(desc(mailRuleRuns.createdAt), desc(mailRuleRuns.id)).limit(Math.min(limit, 100));
  return rows.map((r) => ({ id: r.id, messageId: r.messageId, from: r.fromAddress, subject: r.subject, status: r.status, steps: parse(r.steps, []), createdAt: r.createdAt.toISOString() }));
}

const RECENT_COLS = { id: messages.id, threadId: messages.threadId, fromAddress: messages.fromAddress, fromName: messages.fromName, to: messages.to, cc: messages.cc, subject: messages.subject, snippet: messages.snippet, hasAttachments: messages.hasAttachments, date: messages.date, isRead: messages.isRead };
type Recent = { id: string; threadId: string; fromAddress: string; fromName: string; to: string; cc: string; subject: string; snippet: string; hasAttachments: boolean; date: Date; isRead: boolean };

export function toRuleMessage(m: Pick<Recent, "fromAddress" | "fromName" | "to" | "cc" | "subject" | "hasAttachments">): RuleMessage {
  const addrs = (raw: string) => parse<{ address: string }[]>(raw, []).map((x) => x.address ?? "").filter(Boolean);
  return { from: m.fromAddress, fromName: m.fromName, to: [...addrs(m.to), ...addrs(m.cc)], subject: m.subject, hasAttachments: !!m.hasAttachments };
}

async function recentInbox(deps: Deps, orgId: string, mailboxId: string): Promise<Recent[]> {
  return deps.db.select(RECENT_COLS).from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.mailboxId, mailboxId), inArray(messages.folder, ["inbox", "archive"])))
    .orderBy(desc(messages.date)).limit(RULE_TEST_SCAN) as Promise<Recent[]>;
}

/** "Test on recent mail": which of the mailbox's last 200 messages these conditions catch. Writes nothing. */
export async function testRule(deps: Deps, a: RuleActor, scope: string[] | null, input: { mailboxId: string; match: "all" | "any"; conditions: MailRuleConditionT[] }) {
  person(a);
  if (scope && !scope.includes(input.mailboxId)) throw notFound("Mailbox");
  const rows = await recentInbox(deps, a.orgId, input.mailboxId);
  const hits = rows.filter((m) => ruleMatches(input, toRuleMessage(m)));
  return {
    scanned: rows.length, matched: hits.length,
    sample: hits.slice(0, 10).map((m) => ({ id: m.id, from: m.fromName || m.fromAddress, subject: m.subject, snippet: m.snippet.slice(0, 140), date: m.date.toISOString() })),
  };
}

// ---------------------------------------------------------------- running

interface Ctx { deps: Deps; rule: Row; owner: { userId: string; email: string; name: string; role: AuthContext["role"] }; msg: typeof messages.$inferSelect; quiet?: boolean; personal?: boolean }
type Step = { action: RuleActionKind; ok: boolean; detail?: string; skipped?: true };

async function ownAddresses(deps: Deps, orgId: string) {
  return new Set((await deps.db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.orgId, orgId))).map((r) => r.address.toLowerCase()));
}

async function sendsToday(deps: Deps, ruleId: string): Promise<{ total: number; senders: Set<string> }> {
  const since = new Date(deps.now().getTime() - DAY);
  const rows = await deps.db.select({ from: mailRuleRuns.fromAddress, status: mailRuleRuns.status }).from(mailRuleRuns)
    .where(and(eq(mailRuleRuns.ruleId, ruleId), gte(mailRuleRuns.createdAt, since))).limit(RULE_SENDS_PER_DAY * 4);
  const sent = rows.filter((r) => r.status === "ok" || r.status === "partial");
  return { total: sent.length, senders: new Set(sent.map((r) => (r.from ?? "").toLowerCase())) };
}

async function runAction(c: Ctx, act: MailRuleActionT, guard: { own: Set<string>; sends?: { total: number; senders: Set<string> } }): Promise<Step> {
  const { deps, msg, rule, owner } = c;
  const actor = { orgId: rule.orgId, userId: owner.userId, role: owner.role };
  const suite = { orgId: rule.orgId, userId: owner.userId, email: owner.email, name: owner.name, role: owner.role };
  const step = (ok: boolean, detail?: string): Step => ({ action: act.kind, ok, ...(detail ? { detail } : {}) });
  switch (act.kind) {
    case "label":
      await deps.db.insert(mailThreadLabels).values({ orgId: rule.orgId, threadId: msg.threadId, label: act.label.slice(0, LABEL_MAX), mailboxId: msg.mailboxId, createdAt: deps.now() }).onConflictDoNothing();
      return step(true, act.label);
    case "move_to_tab": {
      const { pinThreadFor } = await import("./tabs-r85");
      return (await pinThreadFor(deps, { orgId: rule.orgId, userId: owner.userId }, msg.threadId, act.tab)) ? step(true) : step(false, "That tab is gone.");
    }
    case "mark_read": case "archive": case "star": {
      const { runBulkMail } = await import("./bulk-r32");
      await runBulkMail(deps, actor, { ids: [msg.id], action: act.kind === "mark_read" ? "read" : act.kind });
      return step(true);
    }
    case "create_task": {
      // PRIV1b (P43): a project task is readable by the project, so mail from a personal mailbox never becomes one.
      if (c.personal) return { action: act.kind, ok: true, skipped: true, detail: "Skipped: tasks aren't made from a personal mailbox." };
      const { createTaskFromThread } = await import("../suite/tasks");
      const t = await createTaskFromThread(deps, { ...suite, system: false }, {
        messageId: msg.id, projectId: act.projectId, priority: act.priority,
        due: act.dueInDays !== undefined ? new Date(deps.now().getTime() + act.dueInDays * DAY).toISOString() : undefined,
      });
      return step(true, (t as { ref?: string }).ref);
    }
    case "notify": {
      const { notify } = await import("../suite/notify");
      await notify(deps, rule.orgId, owner.userId, { type: "automation.email", entityType: "message", entityId: msg.id, title: `${rule.name}: ${msg.subject || "(no subject)"}` });
      return step(true);
    }
    case "forward": case "auto_reply": {
      if (c.quiet) return { action: act.kind, ok: true, skipped: true, detail: "Skipped: replies and forwards only go to new mail." };
      const from = msg.fromAddress.toLowerCase();
      if (guard.own.has(from)) return step(false, "Not sent: the mail came from this workspace.");
      if (guard.sends && guard.sends.total >= RULE_SENDS_PER_DAY) return step(false, `Not sent: this rule already sent ${RULE_SENDS_PER_DAY} today.`);
      const { sendMessage } = await import("./send");
      const auth: AuthContext = { userId: owner.userId, email: owner.email, name: owner.name, orgId: rule.orgId, role: owner.role, sessionId: `rule:${rule.id}` };
      if (act.kind === "auto_reply") {
        if (msg.isBulk || isRobotSender(from)) return step(false, "Not sent: bulk or no reply sender.");
        if (/^(auto|automatic reply|out of office)/i.test(msg.subject.trim())) return step(false, "Not sent: that mail was itself an automatic reply.");
        if (guard.sends?.senders.has(from)) return step(false, "Not sent: already replied to this sender today.");
        const { renderSnippetFor } = await import("../suite/snippets");
        const r = await renderSnippetFor(deps, suite, act.snippetId, { threadId: msg.threadId, mailboxId: msg.mailboxId, to: from });
        const subject = r.subject || (/^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`);
        await sendMessage(deps, auth, { mailboxId: msg.mailboxId, to: [from], subject, text: r.body, inReplyToId: msg.id }, { noQueue: true });
        return step(true, from);
      }
      if (act.to.toLowerCase() === from) return step(false, "Not sent: it would go back to the sender.");
      const atts = await deps.db.select().from(attachments).where(eq(attachments.messageId, msg.id));
      const { attachmentBytes } = await import("./store");
      const files: { filename: string; contentType: string; content: Uint8Array }[] = [];
      let bytes = 0;
      for (const at of atts) {
        if (bytes + at.sizeBytes > 15 * 1024 * 1024) break;
        const content = await attachmentBytes(at, deps.bodyStore).catch(() => null);
        if (!content) continue;
        files.push({ filename: at.filename, contentType: at.contentType, content });
        bytes += at.sizeBytes;
      }
      const head = `---------- Forwarded message ----------\nFrom: ${msg.fromName ? `${msg.fromName} <${msg.fromAddress}>` : msg.fromAddress}\nDate: ${msg.date.toUTCString()}\nSubject: ${msg.subject}\n\n`;
      await sendMessage(deps, auth, { mailboxId: msg.mailboxId, to: [act.to], subject: /^fwd?:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`, text: head + msg.text }, { noQueue: true, attachments: files });
      return step(true, act.to);
    }
  }
}

async function ownerOf(deps: Deps, rule: Row) {
  const row = await deps.db.select({ email: users.email, name: users.name, role: members.role }).from(members).innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, rule.orgId), eq(members.userId, rule.userId))).get();
  return row ? { userId: rule.userId, email: row.email, name: row.name ?? row.email, role: row.role as AuthContext["role"] } : null;
}

/**
 * PRIV1b (P43): on a personal mailbox a rule runs only while its maker can open it at the level its actions need
 * (a read share notifies only). Team mailboxes pass here (runMailRules checks who can open them). A few indexed reads.
 */
export async function ruleGate(deps: Deps, rule: Row, owner: { userId: string; role: AuthContext["role"] }, quiet = false): Promise<{ personal: boolean; ok: boolean }> {
  if (!(await personalInfo(deps.db, rule.orgId, rule.mailboxId))) return { personal: false, ok: true };
  const need = ruleNeed(parse<MailRuleActionT[]>(rule.actions, []), quiet);
  return { personal: true, ok: await canOpen(deps.db, { userId: owner.userId, orgId: rule.orgId, role: owner.role }, rule.mailboxId, need) };
}

/** Runs one rule's actions on one message, logs the run and updates the rule's counters. */
export async function runRuleOn(deps: Deps, rule: Row, msg: typeof messages.$inferSelect, opts: { quiet?: boolean; own?: Set<string>; gate?: { personal: boolean; ok: boolean } } = {}): Promise<MailRuleRun["status"]> {
  const owner = await ownerOf(deps, rule);
  const actions = parse<MailRuleActionT[]>(rule.actions, []);
  const steps: Step[] = [];
  let status: MailRuleRun["status"];
  const gate = owner ? opts.gate ?? await ruleGate(deps, rule, owner, opts.quiet) : null;
  if (!owner) {
    status = "skipped";
    steps.push({ action: actions[0]?.kind ?? "notify", ok: false, detail: "The rule's owner left the workspace." });
  } else if (gate && !gate.ok) {
    status = "skipped";
    steps.push({ action: actions[0]?.kind ?? "notify", ok: false, detail: "The rule's owner can't use this mailbox at the level its actions need." });
  } else {
    const { takeRun } = await import("../suite/automations");
    if (!(await takeRun(deps, rule.orgId))) {
      status = "skipped";
      steps.push({ action: actions[0]?.kind ?? "notify", ok: false, detail: "Monthly automation runs used up." });
    } else {
      const sending = actions.some((x) => SENDING_ACTIONS.includes(x.kind));
      const guard = { own: opts.own ?? (sending ? await ownAddresses(deps, rule.orgId) : new Set<string>()), sends: sending && !opts.quiet ? await sendsToday(deps, rule.id) : undefined };
      for (const act of actions) {
        try {
          steps.push(await runAction({ deps, rule, owner, msg, quiet: opts.quiet, personal: gate?.personal }, act, guard));
        } catch (err) {
          steps.push({ action: act.kind, ok: false, detail: (err instanceof Error ? err.message : "Failed").slice(0, 200) });
        }
      }
      // A send left out on purpose ("Run on recent mail") is neither done nor a problem.
      const counted = steps.filter((s) => !s.skipped);
      const ok = counted.filter((s) => s.ok).length;
      status = !counted.length ? "skipped" : ok === counted.length ? "ok" : ok ? "partial" : "failed";
    }
  }
  const now = deps.now();
  const firstError = steps.find((s) => !s.ok)?.detail ?? null;
  await deps.db.insert(mailRuleRuns).values({ id: newId("mrr"), orgId: rule.orgId, ruleId: rule.id, messageId: msg.id, fromAddress: msg.fromAddress.toLowerCase(), subject: msg.subject.slice(0, 200), status, steps: JSON.stringify(steps), createdAt: now });
  await deps.db.update(mailRules).set({ runCount: sql`${mailRules.runCount} + 1`, lastRunAt: now, lastError: status === "ok" ? null : firstError }).where(eq(mailRules.id, rule.id));
  // Keep the log to 30 days: about one run in twenty trims this rule's older rows.
  if (Math.random() < 0.05) await deps.db.delete(mailRuleRuns).where(and(eq(mailRuleRuns.ruleId, rule.id), lt(mailRuleRuns.createdAt, new Date(now.getTime() - RUN_LOG_DAYS * DAY))));
  return status;
}

/** New mail in a Multies mailbox (services/suite/hooks.ts): runs the enabled rules that match. One read when there are none. */
export async function runMailRules(deps: Deps, m: { orgId: string; mailboxId: string; messageId: string }) {
  const rules = await deps.db.select().from(mailRules).where(and(eq(mailRules.mailboxId, m.mailboxId), eq(mailRules.enabled, true))).orderBy(asc(mailRules.position));
  if (!rules.length) return 0;
  const msg = await deps.db.select().from(messages).where(and(eq(messages.id, m.messageId), eq(messages.orgId, m.orgId))).get();
  if (!msg || msg.folder !== "inbox") return 0;
  const { usersWhoCanOpen } = await import("../team");
  const allowed = new Set(await usersWhoCanOpen(deps.db, m.orgId, m.mailboxId));
  const rm = toRuleMessage(msg);
  let runs = 0;
  for (const r of rules) {
    if (r.orgId !== m.orgId || !allowed.has(r.userId)) continue;
    if (!ruleMatches({ match: r.match, conditions: parse(r.conditions, []) }, rm)) continue;
    await runRuleOn(deps, r, msg);
    runs++;
  }
  return runs;
}

/** "Run on recent mail": applies a rule's quiet actions (never replies or forwards) to matching recent mail. */
export async function runOnRecent(deps: Deps, a: RuleActor, scope: string[] | null, id: string) {
  writable(a);
  const rule = await own(deps, a, id);
  if (scope && !scope.includes(rule.mailboxId)) throw notFound("Mailbox");
  const mine = await ownAddresses(deps, a.orgId);
  const conds = { match: rule.match, conditions: parse<MailRuleConditionT[]>(rule.conditions, []) };
  const recent = (await recentInbox(deps, a.orgId, rule.mailboxId)).filter((m) => ruleMatches(conds, toRuleMessage(m))).slice(0, RECENT_RUN_MAX);
  if (!recent.length) return { ran: 0, matched: 0 };
  const rows = await deps.db.select().from(messages).where(inIds(messages.id, recent.map((r) => r.id)));
  // PRIV1b (P43): the level check once for the whole batch, not once a message.
  const maker = await ownerOf(deps, rule);
  const gate = maker ? await ruleGate(deps, rule, maker, true) : undefined;
  let ran = 0;
  for (const msg of rows) { await runRuleOn(deps, rule, msg, { quiet: true, own: mine, gate }); ran++; }
  return { ran, matched: recent.length };
}

// ---------------------------------------------------------------- labels

/** Labels on threads in the person's mailboxes, with how many threads carry each. */
export async function listLabels(deps: Deps, orgId: string, scope: string[] | null) {
  const rows = await deps.db.select({ label: mailThreadLabels.label, n: sql<number>`count(*)` }).from(mailThreadLabels)
    .where(and(eq(mailThreadLabels.orgId, orgId), scope ? inIds(mailThreadLabels.mailboxId, scope) : undefined))
    .groupBy(mailThreadLabels.label).orderBy(asc(mailThreadLabels.label)).limit(200);
  return rows.map((r) => ({ label: r.label, threads: Number(r.n) }));
}

/** Labels for a page of threads (the mail list). One read; nothing when the page is empty. */
export async function labelsFor(deps: Deps, orgId: string, threadIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const ids = [...new Set(threadIds)].filter(Boolean);
  if (!ids.length) return out;
  const rows = await deps.db.select({ threadId: mailThreadLabels.threadId, label: mailThreadLabels.label }).from(mailThreadLabels)
    .where(and(eq(mailThreadLabels.orgId, orgId), inIds(mailThreadLabels.threadId, ids)));
  for (const r of rows) out.set(r.threadId, [...(out.get(r.threadId) ?? []), r.label].sort());
  return out;
}

export function labelCond(orgId: string, label: string) {
  return sql`${messages.threadId} in (select l.thread_id from mail_thread_labels l where l.org_id = ${orgId} and l.label = ${label})`;
}

async function threadMailbox(deps: Deps, orgId: string, threadId: string, scope: string[] | null) {
  const m = await deps.db.select({ mailboxId: messages.mailboxId }).from(messages).where(and(eq(messages.orgId, orgId), eq(messages.threadId, threadId))).orderBy(desc(messages.date)).limit(20);
  const hit = m.find((x) => !scope || scope.includes(x.mailboxId));
  if (!hit) throw notFound("Thread");
  return hit.mailboxId;
}

export async function addLabel(deps: Deps, a: RuleActor, scope: string[] | null, threadId: string, label: string) {
  writable(a);
  const clean = label.trim().slice(0, LABEL_MAX);
  if (!clean || /^tab:/i.test(clean)) throw badRequest("Pick another label name.");
  const mailboxId = await threadMailbox(deps, a.orgId, threadId, scope);
  await deps.db.insert(mailThreadLabels).values({ orgId: a.orgId, threadId, label: clean, mailboxId, createdAt: deps.now() }).onConflictDoNothing();
  return { labels: (await labelsFor(deps, a.orgId, [threadId])).get(threadId) ?? [] };
}

export async function removeLabel(deps: Deps, a: RuleActor, scope: string[] | null, threadId: string, label: string) {
  writable(a);
  await threadMailbox(deps, a.orgId, threadId, scope);
  await deps.db.delete(mailThreadLabels).where(and(eq(mailThreadLabels.orgId, a.orgId), eq(mailThreadLabels.threadId, threadId), eq(mailThreadLabels.label, label)));
  return { labels: (await labelsFor(deps, a.orgId, [threadId])).get(threadId) ?? [] };
}
