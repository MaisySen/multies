/**
 * R85: the person's Inbox tab style and "teach by moving": moving a thread to a tab pins that thread there and, unless
 * they say not to, every later message from its sender. Pins live in the person's mail prefs row (one write per move),
 * and the tab conditions read them as literals (services/mail/splits.ts), so a pin costs no query and no index.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { mailPrefs, messages } from "../../db/schema";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { addPin, defaultTabOf, parsePins, PIN_SENDERS_MAX, PIN_THREADS_MAX, type TabPins, type TabStyle } from "@/shared/mail-rules-r85";
import { listSplits, tabIdsOf, tabsState, type SplitActor } from "./splits";

function person(a: SplitActor) {
  if (!a.userId || a.agentId) throw new HttpError(403, "person_only", "Inbox tabs belong to a person. Sign in to change them.");
  if (a.scope === "read") throw new HttpError(403, "read_only_key", "This API key can only read.");
  return a.userId;
}

async function writePrefs(deps: Deps, a: { orgId: string; userId: string }, set: { inboxTabs?: TabStyle; tabPins?: string }) {
  const now = deps.now();
  await deps.db.insert(mailPrefs).values({ orgId: a.orgId, userId: a.userId, readStatus: false, ...set, updatedAt: now })
    .onConflictDoUpdate({ target: [mailPrefs.orgId, mailPrefs.userId], set: { ...set, updatedAt: now } });
}

export async function tabSettings(deps: Deps, a: SplitActor) {
  if (!a.userId || a.agentId) return { style: "classic" as TabStyle, chosen: false, defaultTab: "important", senders: [] as { address: string; tab: string }[] };
  const st = await tabsState(deps, a);
  return { style: st.style, chosen: st.chosen, defaultTab: defaultTabOf(st.style), senders: Object.entries(st.pins.s).map(([address, tab]) => ({ address, tab })).reverse() };
}

export async function setTabStyle(deps: Deps, a: SplitActor, style: TabStyle) {
  const userId = person(a);
  await writePrefs(deps, { orgId: a.orgId, userId }, { inboxTabs: style });
  return tabSettings(deps, a);
}

/** Moves a thread to a tab and, when `sender`, sends the sender's later mail there too. Answers what it replaced (for Undo). */
export async function teachTab(deps: Deps, a: SplitActor, scope: string[] | null, input: { messageId: string; tab: string; sender?: boolean }) {
  const userId = person(a);
  const m = await deps.db.select({ threadId: messages.threadId, fromAddress: messages.fromAddress, mailboxId: messages.mailboxId }).from(messages)
    .where(and(eq(messages.id, input.messageId), eq(messages.orgId, a.orgId))).get();
  if (!m || (scope && !scope.includes(m.mailboxId))) throw notFound("Message");
  const [st, list] = await Promise.all([tabsState(deps, a), listSplits(deps, a)]);
  if (st.style === "off") throw badRequest("Inbox tabs are off. Turn them on to sort mail into tabs.");
  if (!tabIdsOf(st.style, list).includes(input.tab)) throw notFound("Tab");
  const sender = m.fromAddress.toLowerCase();
  const previous = { thread: st.pins.t[m.threadId] ?? null, sender: input.sender === false ? undefined : st.pins.s[sender] ?? null };
  const pins: TabPins = {
    t: addPin(st.pins.t, m.threadId, input.tab, PIN_THREADS_MAX),
    s: input.sender === false ? st.pins.s : addPin(st.pins.s, sender, input.tab, PIN_SENDERS_MAX),
  };
  await writePrefs(deps, { orgId: a.orgId, userId }, { tabPins: JSON.stringify(pins) });
  return { tab: input.tab, threadId: m.threadId, sender: input.sender === false ? null : sender, previous };
}

/** Undo for teachTab, and "Forget" for a pinned sender in the tabs sheet: null clears a pin. */
export async function restorePins(deps: Deps, a: SplitActor, input: { threadId?: string; thread?: string | null; sender?: string; senderTab?: string | null }) {
  const userId = person(a);
  const st = await tabsState(deps, a);
  const pins: TabPins = { s: { ...st.pins.s }, t: { ...st.pins.t } };
  if (input.threadId) {
    if (input.thread) pins.t = addPin(pins.t, input.threadId, input.thread, PIN_THREADS_MAX);
    else delete pins.t[input.threadId];
  }
  if (input.sender) {
    const s = input.sender.toLowerCase();
    if (input.senderTab) pins.s = addPin(pins.s, s, input.senderTab, PIN_SENDERS_MAX);
    else delete pins.s[s];
  }
  await writePrefs(deps, { orgId: a.orgId, userId }, { tabPins: JSON.stringify(pins) });
  return tabSettings(deps, a);
}

/** For mail rules: pins a thread to a tab for the rule's owner. False when that tab is gone. */
export async function pinThreadFor(deps: Deps, a: { orgId: string; userId: string }, threadId: string, tab: string): Promise<boolean> {
  const [st, list] = await Promise.all([tabsState(deps, a), listSplits(deps, a)]);
  if (!tabIdsOf(st.style === "off" ? "classic" : st.style, list).includes(tab)) return false;
  if (st.pins.t[threadId] === tab) return true;
  await writePrefs(deps, a, { tabPins: JSON.stringify({ s: st.pins.s, t: addPin(st.pins.t, threadId, tab, PIN_THREADS_MAX) }) });
  return true;
}

export { parsePins };
