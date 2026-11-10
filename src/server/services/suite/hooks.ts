/**
 * What the suite does when mail is stored: contacts from correspondents, replies shown
 * on the tasks linked to the thread, email rules, and a push to phones. Each part is
 * isolated, so nothing here can fail or block mail delivery.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Deps } from "../../context";
import { tasks } from "../../db/schema";
import { recordWrite, type SuiteActor } from "./common";

interface StoredMail {
  orgId: string; mailboxId: string; messageId: string; threadId: string; direction: "inbound" | "outbound";
  from: { address: string; name?: string }; to?: { address: string; name?: string }[]; cc?: { address: string; name?: string }[];
  subject: string; date: Date; folder?: string;
}

export async function onMailStored(deps: Deps, m: StoredMail) {
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { deps.reportError?.(err, { where: `suite.onMailStored.${name}` }); }
  };
  if (m.folder === "spam" || m.folder === "drafts") return;
  // PRIV1b (P2): read once; a personal mailbox's mail stays out of contacts, workspace automations and task activity.
  let personal = false;
  try { personal = !!m.mailboxId && !!(await (await import("../mail-access-priv1a")).personalInfo(deps.db, m.orgId, m.mailboxId)); }
  catch (err) { personal = true; deps.reportError?.(err, { where: "suite.onMailStored.personal" }); }
  await step("contacts", async () => {
    const { upsertFromMail } = await import("./contacts");
    // PRIV1a (MB-366): who writes to someone's personal mailbox stays private; it never fills the workspace's contacts.
    if (personal) return;
    await upsertFromMail(deps, m.orgId, m.direction === "inbound" ? [m.from] : [...(m.to ?? []), ...(m.cc ?? [])], m.date);
  });
  await step("tasks", async () => {
    if (!m.threadId) return;
    const linked = await deps.db.select({ id: tasks.id, assigneeType: tasks.assigneeType, assigneeId: tasks.assigneeId, title: tasks.title }).from(tasks)
      .where(and(eq(tasks.orgId, m.orgId), eq(tasks.threadId, m.threadId), isNull(tasks.deletedAt)));
    if (!linked.length) return;
    // PRIV1b (P2): on a personal mailbox the activity names no sender or subject, and only people who can open it hear of the reply.
    const actor: SuiteActor = personal ? { orgId: m.orgId, userId: "", email: "", name: "Email", system: true } : { orgId: m.orgId, userId: "", email: m.from.address, name: m.from.name || m.from.address, system: true };
    const openers = personal ? new Set(await (await import("../team")).usersWhoCanOpen(deps.db, m.orgId, m.mailboxId)) : null;
    for (const t of linked) {
      await recordWrite(deps, actor, { entityType: "task", entityId: t.id, op: "update", verb: m.direction === "inbound" ? "email_received" : "email_sent", data: personal ? { messageId: m.messageId } : { messageId: m.messageId, from: m.from.address, subject: m.subject } });
      if (m.direction === "inbound" && t.assigneeType === "member" && t.assigneeId && (!openers || openers.has(t.assigneeId))) {
        const { notify } = await import("./notify");
        await notify(deps, m.orgId, t.assigneeId, { type: "task.email_reply", entityType: "task", entityId: t.id, title: `New reply on ${t.title}` });
      }
    }
  });
  if (m.direction !== "inbound") return;
  await step("automations", async () => {
    if (personal) return; // PRIV1b (P2): workspace rules run as a system actor that nobody shared the mailbox with.
    const { runEmailAutomations } = await import("./automations");
    await runEmailAutomations(deps, m.orgId, { messageId: m.messageId, threadId: m.threadId, mailboxId: m.mailboxId, from: m.from.address, subject: m.subject });
  });
  // R85: the person's own mail rules on this mailbox (one read when there are none).
  await step("mail_rules", async () => {
    if (m.folder && m.folder !== "inbox") return;
    const { runMailRules } = await import("../mail/rules-r85");
    await runMailRules(deps, { orgId: m.orgId, mailboxId: m.mailboxId, messageId: m.messageId });
  });
  await step("push", async () => {
    if (!deps.config.push.enabled) return;
    const { pushToUsers } = await import("./push");
    const { usersWhoCanOpen } = await import("../team");
    // R97 one place: a Mail phone switch turned off, a pause and quiet hours hold new mail alerts too.
    const { alertRecipients } = await import("./notify");
    await pushToUsers(deps, m.orgId, await alertRecipients(deps, m.orgId, await usersWhoCanOpen(deps.db, m.orgId, m.mailboxId), "message.received"), { type: "message.received", id: m.messageId });
  });
  // Round 22 (R22.5): new mail on a waiting or done thread puts it back to open (0 writes when nothing changes).
  await step("thread_reopen", async () => {
    const { reopenOnInbound } = await import("./thread-rules");
    await reopenOnInbound(deps, m.orgId, m.threadId);
  });
  // Round 20: a reply cancels "remind me if no reply" and wakes a snoozed thread (0 writes when none).
  await step("mail_schedules", async () => {
    const { cancelOnReply } = await import("../mail/schedules");
    await cancelOnReply(deps, m.mailboxId, m.threadId);
  });
}
