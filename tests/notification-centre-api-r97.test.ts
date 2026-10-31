import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { alertRecipients, decide, getPrefs, notify } from "@/server/services/suite/notify";
import { runNotificationDigests, digestText } from "@/server/services/suite/notify-centre-r97";
import { runDueJobs } from "@/server/services/jobs";
import { defaultDelivery } from "@/shared/notification-centre";
import { notifications } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import type { LogOutbound } from "@/server/services/mail/outbound";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let clock = 0;
let me: { userId: string; orgId: string };
let baseline = 0;
// Mail sent since setup (sign up mails are not counted).
const sentTo = (to: string) => (ctx.outbound as LogOutbound).sent.slice(baseline).filter((m) => m.to.includes(to));

async function setup(env: Record<string, string> = {}) {
  ctx = await makeTestApp(env);
  // Tue 3 Nov 2026, 10:00 in Sydney (UTC+11).
  clock = new Date("2026-11-02T23:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  const body = (await c.get("/api/account/me")).body;
  me = { userId: body.user.id, orgId: body.organization.id };
  baseline = (ctx.outbound as LogOutbound).sent.length;
}
async function teammate(email = "mate@acme.io", name = "Sam Mate") {
  const invite = await c.post("/api/team/invites", { email, role: "member" });
  const m = new Client(ctx.app);
  await m.signup(email, name, "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
const ping = (title: string, type = "task.assigned", userId = me.userId) =>
  notify(ctx.deps, me.orgId, userId, { type, entityType: "task", entityId: `tsk_${title.replace(/\W/g, "")}`, title, actorName: "Sam Mate" });

describe("R97 settings API", () => {
  beforeEach(() => setup());

  it("adds mail per category and delivery, keeping the old fields", async () => {
    const r = (await c.get("/api/notifications/settings")).body;
    expect(r.settings.assignment).toEqual({ inApp: true, push: true, mail: false });
    expect(r.settings.status).toMatchObject({ inApp: true, push: false });
    expect(r.delivery).toMatchObject({ quiet: { enabled: false, start: "22:00", end: "07:00" }, digest: { frequency: "off" }, pausedUntil: null, newMail: true });
    expect(typeof r.delivery.timezone).toBe("string");
  });

  it("saves mail, quiet hours, digest and pause; old style puts still work", async () => {
    const put = await c.put("/api/notifications/settings", { settings: { mention: { mail: true } }, delivery: { timezone: "Asia/Kathmandu", quiet: { enabled: true, start: "21:00", end: "06:30", days: [5, 1, 1] }, digest: { frequency: "weekly", time: "09:00", weekday: 1 }, pause: "1h" } });
    expect(put.status).toBe(200);
    expect(put.body.settings.mention).toEqual({ inApp: true, push: true, mail: true });
    expect(put.body.delivery).toMatchObject({ timezone: "Asia/Kathmandu", quiet: { enabled: true, start: "21:00", end: "06:30", days: [1, 5] }, digest: { frequency: "weekly", time: "09:00", weekday: 1 } });
    expect(Date.parse(put.body.delivery.pausedUntil)).toBeGreaterThan(clock);
    // A settings only put (the phone app's shape) leaves delivery alone.
    const old = await c.put("/api/notifications/settings", { settings: { chat: { push: false } } });
    expect(old.body.settings.chat).toMatchObject({ push: false });
    expect(old.body.delivery.timezone).toBe("Asia/Kathmandu");
    const resumed = await c.put("/api/notifications/settings", { delivery: { pause: "resume" } });
    expect(resumed.body.delivery.pausedUntil).toBeNull();
  });

  it("refuses bad input", async () => {
    expect((await c.put("/api/notifications/settings", {})).status).toBe(422);
    expect((await c.put("/api/notifications/settings", { delivery: { timezone: "Mars/Base" } })).status).toBe(422);
    expect((await c.put("/api/notifications/settings", { delivery: { quiet: { start: "7pm" } } })).status).toBe(422);
    expect((await c.put("/api/notifications/settings", { delivery: { digest: { frequency: "hourly" } } })).status).toBe(422);
    expect((await c.put("/api/notifications/settings", { delivery: { surprise: true } })).status).toBe(422);
    expect((await c.put("/api/notifications/settings", { settings: { bogus: { mail: true } } })).status).toBe(422);
  });

  it("is per member: a teammate's settings never change mine, and nobody reads another's", async () => {
    const mate = await teammate();
    await mate.client.put("/api/notifications/settings", { settings: { assignment: { inApp: false } }, delivery: { pause: "3h" } });
    const mine = (await c.get("/api/notifications/settings")).body;
    expect(mine.settings.assignment.inApp).toBe(true);
    expect(mine.delivery.pausedUntil).toBeNull();
    await ping("For Sam", "task.assigned", mate.id);
    expect((await mate.client.get("/api/notifications")).body.notifications).toHaveLength(0);
    await ping("For Olive");
    const list = (await c.get("/api/notifications")).body.notifications as { title: string }[];
    expect(list.map((n) => n.title)).toEqual(["For Olive"]);
  });

  it("with the centre off answers exactly the old shape", async () => {
    await setup({ NOTIFICATION_CENTRE: "off" });
    const r = (await c.get("/api/notifications/settings")).body;
    expect(r.delivery).toBeUndefined();
    expect(r.settings.assignment).toEqual({ inApp: true, push: true });
    expect((await c.put("/api/notifications/settings", { delivery: { pause: "1h" } })).status).toBe(422);
    expect((await c.put("/api/notifications/settings", { settings: { assignment: { push: false } } })).body.settings.assignment).toEqual({ inApp: true, push: false });
  });
});

describe("R97 one place: decide and alertRecipients", () => {
  beforeEach(() => setup());

  it("quiet hours hold phone alerts but items still reach the inbox", async () => {
    const prefs = await getPrefs(ctx.deps, me.orgId, me.userId);
    const d = { ...defaultDelivery("Australia/Sydney"), quiet: { enabled: true, start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4, 5, 6], allowUrgent: true } };
    const night = new Date("2026-11-03T12:30:00Z"); // 23:30 Sydney
    expect(decide(prefs, d, "assignment", night)).toEqual({ inApp: true, push: false, mailNow: false });
    expect(decide(prefs, d, "mention", night).push).toBe(true);
    expect(decide(prefs, d, "assignment", new Date("2026-11-03T00:00:00Z")).push).toBe(true);
    expect(decide(prefs, null, "assignment", night).push).toBe(true); // centre off: unchanged behaviour
  });

  it("new mail alerts: unsaved people keep them; the New mail switch off or a pause holds them; other switches do not", async () => {
    const mate = await teammate();
    const third = await teammate("third@acme.io", "Tia Third");
    expect(await alertRecipients(ctx.deps, me.orgId, [me.userId, mate.id, third.id], "message.received")).toHaveLength(3);
    await c.put("/api/notifications/settings", { delivery: { newMail: false } });
    await mate.client.put("/api/notifications/settings", { delivery: { pause: "1h" } });
    await third.client.put("/api/notifications/settings", { settings: { mention: { mail: true } } });
    expect(await alertRecipients(ctx.deps, me.orgId, [me.userId, mate.id, third.id], "message.received")).toEqual([third.id]);
    clock += 3600_000 + 5000; // the pause ends by itself
    expect(await alertRecipients(ctx.deps, me.orgId, [me.userId, mate.id, third.id], "message.received")).toEqual([mate.id, third.id]);
  });
});

describe("R97 mail and digests", () => {
  beforeEach(() => setup());

  it("mail as it happens goes through the job queue, only for categories with Mail on", async () => {
    await c.put("/api/notifications/settings", { settings: { assignment: { mail: true } } });
    await ping("Write the brief");
    await ping("Status only", "goal.updated");
    await runDueJobs(ctx.deps, 10, { types: ["notify.mail"] });
    const sent = sentTo("owner@acme.io");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Assigned to you: Write the brief");
    expect(sent[0].text).toContain("/app/tasks?task=");
  });

  it("no instant mail during quiet hours or a pause", async () => {
    await c.put("/api/notifications/settings", { settings: { assignment: { mail: true } }, delivery: { pause: "1h" } });
    await ping("Paused one");
    await runDueJobs(ctx.deps, 10, { types: ["notify.mail"] });
    expect(sentTo("owner@acme.io")).toHaveLength(0);
    expect((await c.get("/api/notifications")).body.notifications).toHaveLength(1);
  });

  it("a daily digest at the person's time lists unread items once, and sends nothing when empty", async () => {
    await c.put("/api/notifications/settings", { settings: { assignment: { mail: true }, comment: { mail: true } }, delivery: { timezone: "Australia/Sydney", digest: { frequency: "daily", time: "08:00" } } });
    await ping("First task");
    await ping("Second task");
    await ping("A comment", "task.commented");
    await ping("Not wanted", "goal.updated");
    // Read items are left out.
    const readOne = (await c.get("/api/notifications")).body.notifications.find((n: { title: string }) => n.title === "Second task");
    await c.post("/api/notifications/read", { ids: [readOne.id] });
    // No mail before the time.
    expect((await runNotificationDigests(ctx.deps)).due).toBe(0);
    clock = new Date("2026-11-03T21:00:30Z").getTime(); // Wed 08:00:30 Sydney
    expect(await runNotificationDigests(ctx.deps)).toEqual({ due: 1, sent: 1 });
    const mail = sentTo("owner@acme.io");
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toBe("2 new notifications in your daily digest");
    expect(mail[0].text).toContain("First task");
    expect(mail[0].text).toContain("A comment");
    expect(mail[0].text).not.toContain("Second task");
    expect(mail[0].text).not.toContain("Not wanted");
    // Next day, nothing new: no second mail, and the clock moved on.
    clock = new Date("2026-11-04T21:00:30Z").getTime();
    expect(await runNotificationDigests(ctx.deps)).toEqual({ due: 1, sent: 0 });
    expect(sentTo("owner@acme.io")).toHaveLength(1);
    expect((await runNotificationDigests(ctx.deps)).due).toBe(0);
  });

  it("with a digest on, Mail categories wait for the digest instead of mailing each one", async () => {
    await c.put("/api/notifications/settings", { settings: { assignment: { mail: true } }, delivery: { digest: { frequency: "weekly", weekday: 3, time: "08:00" } } });
    await ping("Batched");
    await runDueJobs(ctx.deps, 10, { types: ["notify.mail"] });
    expect(sentTo("owner@acme.io")).toHaveLength(0);
  });

  it("caps a long digest and counts the rest", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ title: `T${i}`, actorName: null }));
    const text = digestText([{ category: "assignment", items, more: 12 }], "weekly");
    expect(text).toContain("Assigned to you (15)");
    expect(text).toContain("and 12 more");
    expect(text).toContain("weekly notification digest");
  });

  it("turning the digest off stops the clock", async () => {
    await c.put("/api/notifications/settings", { settings: { assignment: { mail: true } }, delivery: { digest: { frequency: "daily" } } });
    await c.put("/api/notifications/settings", { delivery: { digest: { frequency: "off" } } });
    clock += 3 * 86_400_000;
    expect((await runNotificationDigests(ctx.deps)).due).toBe(0);
    expect((await ctx.db.select().from(notifications).where(eq(notifications.userId, me.userId))).length).toBe(0);
  });
});
