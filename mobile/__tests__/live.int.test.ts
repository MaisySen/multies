/**
 * @jest-environment node
 */
/**
 * Runs the app's real API client against a live MyMail server. Skipped unless
 * MYMAIL_LIVE_EMAIL and MYMAIL_LIVE_PASSWORD are set (never commit them):
 *   MYMAIL_LIVE_EMAIL=... MYMAIL_LIVE_PASSWORD=... npx jest live
 */
import { HttpTransport } from "@/api/transport";
import { endpoints } from "@/api/endpoints";
import type { Jar } from "@/lib/cookies";

const email = process.env.MYMAIL_LIVE_EMAIL;
const password = process.env.MYMAIL_LIVE_PASSWORD;
const base = process.env.MYMAIL_LIVE_BASE ?? "https://mymail.mymail-app.workers.dev";
const run = email && password ? it : it.skip;
/** MYMAIL_LIVE_DEMO=1 runs the tasks and push check in a fresh demo workspace (no real data). */
const runDemo = process.env.MYMAIL_LIVE_DEMO === "1" ? it : it.skip;

/** jest-expo swaps out fetch and web streams, so the live test talks HTTPS through Node directly. */
function nodeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const https = (url.startsWith("http:") ? require("node:http") : require("node:https")) as typeof import("node:https");
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method ?? "GET", headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const setCookie = res.headers["set-cookie"];
        resolve({
          ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, text: async () => body,
          headers: { get: (k: string) => (k.toLowerCase() === "set-cookie" ? (setCookie ? setCookie.join(", ") : null) : (res.headers[k.toLowerCase()] as string) ?? null) },
        } as unknown as Response);
      });
    });
    req.on("error", reject);
    if (init.body) req.write(init.body as string);
    req.end();
  });
}

run("signs in, reads mail, approvals and agents, and signs out on the live API", async () => {
  let jar: Jar = {};
  const api = endpoints(new HttpTransport({ get: () => jar, set: (j) => { jar = j; } }, () => {}, base, nodeFetch as unknown as typeof fetch));
  const r = await api.signIn(email!, password!);
  expect(r.twoFactorRedirect).toBeFalsy();
  expect(Object.keys(jar).some((k) => k.endsWith("session_token"))).toBe(true);
  const me = await api.me();
  expect(me.user.email).toBe(email!.toLowerCase());
  const overview = await api.overview();
  expect(Array.isArray(overview.mailboxes)).toBe(true);
  const page = await api.messages({ folder: "inbox" });
  expect(Array.isArray(page.messages)).toBe(true);
  expect(Array.isArray((await api.approvals("pending")).approvals)).toBe(true);
  expect(Array.isArray((await api.agents()).agents)).toBe(true);
  await api.signOut();
  await expect(api.me()).rejects.toMatchObject({ status: 401 });
}, 180_000);

runDemo("demo workspace: lists tasks, makes one from an email, moves it to done and registers a push token", async () => {
  let jar: Jar = {};
  const api = endpoints(new HttpTransport({ get: () => jar, set: (j) => { jar = j; } }, () => {}, base, nodeFetch as unknown as typeof fetch));
  const t0 = Date.now();
  await api.startDemo();
  const demoMs = Date.now() - t0;
  const me = await api.me();
  expect(me.organization?.isDemo).toBe(true);

  const before = (await api.tasks()).tasks;
  expect(Array.isArray(before)).toBe(true);
  const projects = (await api.projects()).projects;
  expect(Array.isArray(projects)).toBe(true);
  const people = (await api.assignees()).assignees;
  expect(people.some((p) => p.type === "member")).toBe(true);

  const inbox = (await api.messages({ folder: "inbox" })).messages;
  expect(inbox.length).toBeGreaterThan(0);
  const m = inbox[0];
  const { task } = await api.taskFromEmail({ messageId: m.id });
  expect(task.source?.threadId).toBe(m.threadId);
  expect(task.title.length).toBeGreaterThan(0);
  const detail = await api.task(task.id);
  expect(detail.thread.map((x) => x.id)).toContain(m.id);
  expect((await api.tasks({ threadId: m.threadId })).tasks.map((x) => x.id)).toContain(task.id);

  const { task: done } = await api.updateTask(task.id, { status: "done", version: task.version });
  expect(done.status).toBe("done");
  await expect(api.updateTask(task.id, { title: "stale", version: task.version })).rejects.toMatchObject({ status: 409 });
  const { comment } = await api.addComment(task.id, "Checked from the mobile app's live test.");
  expect(comment.body).toMatch(/live test/);

  const token = `ExponentPushToken[mymailLiveCheck${Date.now().toString(36)}]`;
  const reg = await api.registerPushDevice(token, "android");
  expect(reg.ok).toBe(true);
  const devices = await api.pushDevices();
  expect(devices.devices.length).toBeGreaterThan(0);
  await api.unregisterPushDevice(token);
  expect((await api.pushDevices()).devices.length).toBe(devices.devices.length - 1);

  console.log(JSON.stringify({ demoMs, tasksBefore: before.length, made: task.ref, done: done.statusName, pushEnabledOnServer: reg.enabled }));
  await api.signOut();
}, 180_000);

runDemo("demo workspace: times a task, reads the running timer, stops it and starts a meeting from the task", async () => {
  let jar: Jar = {};
  const api = endpoints(new HttpTransport({ get: () => jar, set: (j) => { jar = j; } }, () => {}, base, nodeFetch as unknown as typeof fetch));
  await api.startDemo();
  const { tasks } = await api.tasks();
  expect(tasks.length).toBeGreaterThan(0);
  const task = tasks.find((t) => t.status !== "done") ?? tasks[0];

  const { entry: started } = await api.startTimer(task.ref);
  expect(started).toMatchObject({ taskId: task.id, running: true, source: "timer" });
  const { entry: running } = await api.runningTimer();
  expect(running?.id).toBe(started.id);
  await new Promise((r) => setTimeout(r, 2000));
  const { entry: stopped } = await api.stopTimer();
  expect(stopped).toMatchObject({ id: started.id, running: false });
  expect((await api.runningTimer()).entry).toBeNull();
  const { entry: logged } = await api.logTime({ taskId: task.id, minutes: 15, note: "Logged from the mobile app's live test." });
  expect(logged.source).toBe("manual");
  const detail = await api.task(task.id);
  expect(detail.time?.entries.map((e) => e.id)).toEqual(expect.arrayContaining([started.id, logged.id]));
  expect(detail.time!.totalSeconds).toBeGreaterThanOrEqual(15 * 60);
  expect(Array.isArray(detail.blockedBy)).toBe(true);

  const { meeting } = await api.createMeeting({ source: { type: "task", id: task.id }, title: task.title });
  expect(meeting.source).toMatchObject({ type: "task", id: task.id });
  expect(meeting.joinUrl).toBe(`${base}/app/meetings/${meeting.id}`);
  expect(meeting.guestUrl).toMatch(/\/m\//);
  const upcoming = await api.meetings(true);
  expect(upcoming.meetings.map((m) => m.id)).toContain(meeting.id);

  console.log(JSON.stringify({ task: task.ref, timerSeconds: stopped?.seconds, totalSeconds: detail.time!.totalSeconds, meeting: meeting.id, joinUrl: meeting.joinUrl, guestHost: new URL(meeting.guestUrl).host, videoEnabled: upcoming.videoEnabled }));
  await api.signOut();
}, 180_000);

runDemo("demo workspace: reads a task's custom fields, sets a checkbox field and reads the portfolio", async () => {
  let jar: Jar = {};
  const transport = new HttpTransport({ get: () => jar, set: (j) => { jar = j; } }, () => {}, base, nodeFetch as unknown as typeof fetch);
  const api = endpoints(transport);
  await api.startDemo();
  const { tasks } = await api.tasks();
  const task = tasks.find((t) => t.status !== "done" && t.projectId) ?? tasks[0];
  expect(task.projectId).toBeTruthy();
  let detail = await api.task(task.id);
  expect(Array.isArray(detail.customFields)).toBe(true);
  expect(typeof detail.task.fields).toBe("object");
  let box = detail.customFields!.find((f) => f.type === "checkbox");
  // A demo project may have no checkbox field: add one through the same session route the web app uses.
  if (!box) {
    ({ field: box } = await transport.request<{ field: NonNullable<typeof box> }>("POST", "/fields", { projectId: task.projectId, name: "Approved", type: "checkbox" }));
    detail = await api.task(task.id);
  }
  expect(detail.customFields!.map((f) => f.id)).toContain(box.id);
  expect((await api.fields(task.projectId!)).fields.map((f) => f.id)).toContain(box.id);
  const want = detail.task.fields?.[box.id] !== true;
  const { task: updated } = await api.updateTask(task.id, { fields: { [box.id]: want } });
  // The server stores an unticked box as no value.
  const shown = (v: unknown) => v === true;
  expect(shown(updated.fields?.[box.id])).toBe(want);
  expect(shown((await api.task(task.id)).task.fields?.[box.id])).toBe(want);
  const { task: back } = await api.updateTask(task.id, { fields: { [box.id]: !want } });
  expect(shown(back.fields?.[box.id])).toBe(!want);

  const { projects } = await api.portfolio();
  expect(projects.length).toBeGreaterThan(0);
  const p = projects.find((x) => x.id === task.projectId)!;
  expect(p).toBeTruthy();
  expect(p.progress).toBeGreaterThanOrEqual(0);
  expect(p.progress).toBeLessThanOrEqual(100);
  for (const k of ["health", "owner", "overdue", "timeLoggedSeconds", "nextDue", "total", "done"]) expect(p).toHaveProperty(k);

  console.log(JSON.stringify({ task: task.ref, fieldTypes: detail.customFields!.map((f) => f.type), checkbox: box.name, set: want, thenSet: !want, values: Object.keys(detail.task.fields ?? {}).length,
    portfolio: projects.map((x) => ({ key: x.key, health: x.health, progress: x.progress, overdue: x.overdue, time: x.timeLoggedSeconds, nextDue: x.nextDue })) }));
  await api.signOut();
}, 180_000);
