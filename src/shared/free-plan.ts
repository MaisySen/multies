/**
 * R58 (MB-237): what the Free plan includes and where it stops, for the public free plan page.
 * Every number is read from src/shared/plans.ts (the same limits the server enforces), never typed
 * here, so the page cannot drift from the plan. tests/free-plan-r58.test.ts checks this.
 */
import { ADDONS, PLANS, formatPlanPrice, type Addon, type Plan } from "./plans";
import { LOCALE } from "./locale";

const n = (v: number) => v.toLocaleString(LOCALE);
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const gb = (mb: number) => `${n(Math.round((mb / 1024) * 10) / 10)} GB`;

export interface FreeLimit {
  /** Stable key for tests and React. */
  key: "domains" | "mailboxes" | "seats" | "dailySends" | "storage" | "agentInboxes" | "automation";
  /** The ceiling, in words ("3 people"). */
  value: string;
  /** What it means. */
  label: string;
  /** What raises it, or null when nothing needs to. */
  more: string | null;
}

const price = (a: Addon) => `${formatPlanPrice(a.priceMonthly)} a month`;

/** The Free plan's ceilings, each with the add-on that raises it for the whole workspace. */
export function freeLimits(plan: Plan = PLANS.starter, addons: Record<string, Addon> = ADDONS): FreeLimit[] {
  const l = plan.limits;
  const box = addons.mailboxes, dom = addons.domain, send = addons.send_boost, store = addons.storage, agent = addons.agent_inbox;
  return [
    { key: "domains", value: plural(l.domains, "domain"), label: "The domain you own, for your team's mail", more: `Add another domain for ${price(dom)}` },
    { key: "mailboxes", value: plural(l.mailboxes, "mailbox", "mailboxes"), label: `Real addresses on your domain, plus ${n(l.aliases)} aliases`, more: `Add ${box.unit} for ${price(box)}` },
    { key: "seats", value: plural(l.seats, "person", "people"), label: "People who can sign in, the owner included", more: `${n(box.grants.seats ?? 0)} more come with each mailbox pack` },
    { key: "dailySends", value: `${n(l.dailySends)} a day`, label: "Recipients outside Multies you can send to each day", more: `Add ${send.unit} for ${price(send)}` },
    { key: "storage", value: gb(l.storageMb), label: "Storage shared by every mailbox", more: `Add ${store.unit} for ${price(store)}` },
    { key: "agentInboxes", value: plural(l.agentInboxes, "agent inbox", "agent inboxes"), label: `For AI agents through the API and MCP, ${n(l.agentMessagesMonthly)} agent messages a month`, more: `Add another for ${price(agent)}` },
    { key: "automation", value: `${n(l.automationRunsMonthly)} a month`, label: "Automation runs: mail rules, status rules and reminders", more: null },
  ];
}

/** One line for the top of the page: "1 domain, 3 mailboxes and 3 people, free for good." */
export function freeHeadline(plan: Plan = PLANS.starter): string {
  const l = plan.limits;
  return `${plural(l.domains, "domain")}, ${plural(l.mailboxes, "mailbox", "mailboxes")} and ${plural(l.seats, "person", "people")}, free for good.`;
}

/** What the team gets as it grows past the ceiling: the mailbox pack, in words. */
export function growLine(plan: Plan = PLANS.starter, addons: Record<string, Addon> = ADDONS): string {
  const box = addons.mailboxes;
  return `Past ${plural(plan.limits.seats, "person", "people")}, a mailbox pack adds ${box.unit} and ${n(box.grants.seats ?? 0)} more people for ${price(box)}. That price is for the whole workspace, not per person.`;
}
