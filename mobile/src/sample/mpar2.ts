/** MPAR2: the sample workspace's answers for the account, plan and billing, preferences and Get started screens. */
import type { BillingView, Checklist, ToursMe } from "@/lib/mpar2";

const STEPS: Omit<Checklist["steps"][number], "done">[] = [
  { id: "mail", kind: "data", title: "Set up mail", body: "Add a mailbox or connect the one you already use.", to: "/app/settings/mailboxes" },
  { id: "invite", kind: "data", title: "Invite a teammate", body: "Work together on mail, tasks and docs.", to: "/app/settings/team" },
  { id: "task", kind: "data", title: "Create a task", body: "Write down the first thing to get done.", to: "/app/tasks" },
  { id: "palette", kind: "mark", title: "Try Ctrl K", body: "Jump anywhere and do anything from the keyboard.", action: "palette" },
  { id: "tour", kind: "mark", title: "Take the quick tour", body: "A one minute look at where everything lives.", action: "tour" },
];

export interface SampleMpar2 { done: string[]; dismissed: boolean; celebrated: boolean; timezone: string | null; locale: string | null }
export const sampleMpar2 = (): SampleMpar2 => ({ done: ["mail", "task"], dismissed: false, celebrated: false, timezone: "Australia/Sydney", locale: null });

function checklist(s: SampleMpar2): Checklist {
  const steps = STEPS.map((x) => ({ ...x, done: s.done.includes(String(x.id)) }));
  const doneCount = steps.filter((x) => x.done).length;
  return { steps, doneCount, total: steps.length, complete: doneCount === steps.length, dismissed: s.dismissed, celebrated: s.celebrated };
}

const BILLING: BillingView = {
  enabled: true,
  plan: { id: "free", name: "Free" },
  interval: null,
  subscription: null,
  dunning: null,
  usage: { domains: 1, mailboxes: 3, seats: 4, sendsToday: 12, storageMb: 640 },
  limits: { domains: 1, mailboxes: 5, seats: 5, dailySends: 100, storageMb: 5120 },
};

/** Answers a path for these screens, or undefined when it is not one of them. */
export function mpar2Route(s: SampleMpar2, method: string, path: string, body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === "GET" && path === "/billing") return BILLING;
  if (method === "GET" && path === "/tours/me") return { enabled: true, checklist: checklist(s) } satisfies ToursMe;
  if (method === "POST" && path === "/tours/checklist") {
    const a = String(b.action ?? "");
    if (a === "mark" && typeof b.step === "string" && !s.done.includes(b.step)) s.done.push(b.step);
    if (a === "dismiss") s.dismissed = true;
    if (a === "resume") s.dismissed = false;
    if (a === "celebrated") s.celebrated = true;
    return { enabled: true, checklist: checklist(s) } satisfies ToursMe;
  }
  if (method === "PATCH" && path === "/account/preferences") {
    if (typeof b.timezone === "string") s.timezone = b.timezone;
    if (typeof b.locale === "string") s.locale = b.locale;
    return { ok: true };
  }
  // The sample person's name and password cannot change (the screens say so); answer like the server would.
  if (method === "POST" && (path === "/auth/update-user" || path === "/auth/change-password")) return { status: true };
  return undefined;
}
