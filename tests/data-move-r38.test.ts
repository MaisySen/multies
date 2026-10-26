import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync, unzipSync, strFromU8 } from "fflate";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { defaultMapping, mapRows, readTable, ZIP_PREFIX } from "@/server/services/work-import/parse";
import { docToMarkdown, parseIcsEvents, readContacts, toIcs, toMboxEntry, toVcard } from "@/server/services/data-move/formats";
import { markdownToDoc } from "@/server/services/suite/markdown-doc";
import { contacts, docs, meetings, projectStatuses, projects, tasks } from "@/server/db/schema";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures/import", name), "utf8");
const zipB64 = (files: Record<string, string>) => {
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return ZIP_PREFIX + btoa(s);
};

async function owner(email = "owner@acme.io") {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup(email, "Owner Person");
  const me = (await c.get("/api/account/me")).body;
  return { ...ctx, c, orgId: me.organization.id as string };
}

describe("move your data: file formats", () => {
  it("reads a task list CSV with sections, notes, subtasks, priorities and @labels", () => {
    const t = readTable(fixture("todoist.csv"), "todoist.csv");
    expect(t.source).toBe("todoist");
    const { rows } = mapRows(t, defaultMapping(t));
    expect(rows.map((r) => r.title)).toEqual(["Write the brief", "Collect quotes", "Book the venue"]);
    expect(rows[0]).toMatchObject({ status: "Planning", priority: "urgent", labels: ["launch"], comments: ["Remember the budget line"] });
    expect(rows[0].assignees).toEqual(["Owner Person"]);
    expect(rows[1]).toMatchObject({ parent: "todoist-1", priority: "high" });
    expect(rows[2]).toMatchObject({ status: "Doing", assignees: ["Pat Outside"], priority: "none" });
    expect(rows[2].due?.toISOString().slice(0, 10)).toBe("2026-11-20");
  });

  it("reads a Markdown and CSV zip: the table becomes tasks and each row's page its description", () => {
    const t = readTable(zipB64({ "Tasks 0123456789abcdef0123456789abcdef.csv": fixture("notion-tasks.csv"), "Tasks/Plan launch 0123456789abcdef0123456789abcdef.md": fixture("notion-page.md") }));
    expect(t.source).toBe("notion");
    const { rows } = mapRows(t, defaultMapping(t));
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toContain("## Steps");
    expect(rows[0].description).not.toContain("Status: In progress");
    expect(rows[1].description).toBe("");
  });

  it("reads vCards (3.0, 2.1, 4.0) and a contacts CSV, skipping cards without an email", () => {
    const v = readContacts(fixture("contacts.vcf"));
    expect(v.skipped).toBe(1);
    expect(v.contacts).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com", phone: "+61 400 000 001", title: "Analyst", company: "Engines Pty Ltd", notes: "Met at the meetup, keen on reports" },
      { name: "Grace Hopper", email: "grace@example.com", phone: null, title: null, company: null, notes: "" },
    ]);
    const c = readContacts(fixture("contacts.csv"));
    expect(c.contacts).toEqual([{ name: "Linus Example", email: "linus@example.com", phone: "+61 400 000 004", title: "Lead", company: "Kernel Co", notes: "Prefers mail, not calls" }]);
    expect(c.skipped).toBe(1);
    // A card written out reads back the same.
    expect(readContacts(toVcard(v.contacts[0])).contacts[0]).toEqual(v.contacts[0]);
  });

  it("reads calendar events: times, durations, weekly rules, all day events, and leaves cancelled ones out", () => {
    const { events, skipped } = parseIcsEvents(fixture("calendar.ics"));
    expect(skipped).toBe(1);
    expect(events.map((e) => e.title)).toEqual(["Planning call, round 2", "Standup", "Team day off"]);
    expect(events[0]).toMatchObject({ durationMin: 60, invitees: ["ada@example.com"], recurrence: null });
    expect(events[0].startsAt.toISOString()).toBe("2026-11-10T23:00:00.000Z");
    expect(events[0].description).toContain("Where: Room 4");
    expect(events[1]).toMatchObject({ durationMin: 30, recurrence: "FREQ=WEEKLY;BYDAY=TH;COUNT=4" });
    expect(events[1].startsAt.toISOString()).toBe("2026-11-11T22:00:00.000Z");
    expect(events[2]).toMatchObject({ allDay: true, durationMin: 1440, recurrence: null });
    expect(events[2].description).toContain("FREQ=YEARLY");
    const again = parseIcsEvents(toIcs(events.map((e, i) => ({ id: `m${i}`, ...e })))).events;
    expect(again.map((e) => [e.title, e.startsAt.toISOString(), e.durationMin])).toEqual(events.map((e) => [e.title, e.startsAt.toISOString(), e.durationMin]));
  });

  it("writes docs as Markdown that reads back to the same shape", () => {
    const md = "## Steps\n\n- Pick a date\n- Tell **everyone**\n\n> A quote\n\n```\ncode here\n```";
    const out = docToMarkdown("Plan", markdownToDoc(md) as never);
    expect(out).toBe(`# Plan\n\n${md}\n`);
  });

  it("writes mail as mbox, escaping From lines in the body", () => {
    const e = toMboxEntry({ fromAddress: "a@x.io", fromName: "A", to: JSON.stringify([{ address: "b@x.io" }]), cc: "[]", subject: "Hi", text: "Hello\nFrom the team", html: null, createdAt: new Date("2026-10-27T01:02:03Z") });
    expect(e.startsWith("From a@x.io Tue Oct 27 01:02:03 2026\n")).toBe(true);
    expect(e).toContain("\n>From the team");
    expect(e).toContain("To: b@x.io");
  });
});

describe("move your data: imports, undo and the export round trip", () => {
  it("imports a CSV with status and people mapping, shows it in the history, and Undo removes exactly what it made", async () => {
    const { c, db, orgId } = await owner();
    const keep = await c.post("/api/projects", { name: "Kept" });
    expect(keep.status).toBe(201);
    const content = "Title,Status,Assignee\nOne,Backlog,pat@outside.io\nTwo,Shipped,owner@acme.io\nThree,Backlog,\n";
    const pre = await c.post("/api/data-moves/imports/preview", { kind: "tasks", fileName: "plan.csv", content });
    expect(pre.status).toBe(200);
    expect(pre.body.unknownAssignees).toEqual(["pat@outside.io"]);
    const run = await c.post("/api/data-moves/imports/run", { kind: "tasks", fileName: "plan.csv", content, projectName: "Plan", people: { "pat@outside.io": "" } });
    expect(run.status).toBe(200);
    expect(run.body.move).toMatchObject({ status: "done", total: 3, created: 3, canUndo: true });
    const list = await c.get("/api/data-moves");
    expect(list.body.items[0].id).toBe(run.body.move.id);
    const pid = run.body.move.projectId as string;
    expect((await db.select().from(tasks).where(eq(tasks.projectId, pid))).length).toBe(3);
    const undo = await c.post(`/api/data-moves/${run.body.move.id}/undo`, {});
    expect(undo.status).toBe(200);
    expect(undo.body.removed).toBe(3);
    expect(undo.body.move.status).toBe("undone");
    expect((await db.select().from(tasks).where(eq(tasks.orgId, orgId))).length).toBe(0);
    const left = await db.select({ name: projects.name }).from(projects).where(eq(projects.orgId, orgId));
    expect(left.map((p) => p.name)).toContain("Kept");
    expect(left.map((p) => p.name)).not.toContain("Plan");
  });

  it("maps file statuses onto an existing project's statuses", async () => {
    const { c, db } = await owner();
    const p = (await c.post("/api/projects", { name: "Board" })).body;
    const statuses = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, p.id));
    const doing = statuses.find((s) => s.category === "doing")!;
    const run = await c.post("/api/data-moves/imports/run", { kind: "tasks", content: "Title,Status\nA,Working on it\n", projectId: p.id, statusMap: { "working on it": doing.id } });
    expect(run.status).toBe(200);
    const [t] = await db.select().from(tasks).where(eq(tasks.projectId, p.id));
    expect(t.statusId).toBe(doing.id);
    expect(run.body.move.created).toBe(1);
  });

  it("imports contacts, calendar and docs, skips contacts already there, and undoes each", async () => {
    const { c, db, orgId } = await owner();
    const con = await c.post("/api/data-moves/imports/run", { kind: "contacts", fileName: "contacts.vcf", content: fixture("contacts.vcf") });
    expect(con.body.move).toMatchObject({ status: "done", created: 2 });
    const again = await c.post("/api/data-moves/imports/preview", { kind: "contacts", content: fixture("contacts.vcf") });
    expect(again.body.alreadyThere).toBe(2);
    const cal = await c.post("/api/data-moves/imports/run", { kind: "calendar", fileName: "calendar.ics", content: fixture("calendar.ics") });
    expect(cal.body.move).toMatchObject({ status: "done", created: 3 });
    const doc = await c.post("/api/data-moves/imports/run", { kind: "docs", fileName: "pages.zip", content: zipB64({ "a.md": "# First\n\nHello", "b.md": "Second body" }) });
    expect(doc.body.move).toMatchObject({ status: "done", created: 2 });
    expect((await db.select().from(meetings).where(eq(meetings.orgId, orgId))).length).toBe(3);
    for (const r of [con, cal, doc]) expect((await c.post(`/api/data-moves/${r.body.move.id}/undo`, {})).status).toBe(200);
    expect((await db.select().from(contacts).where(eq(contacts.orgId, orgId))).length).toBe(0);
    expect((await db.select().from(meetings).where(eq(meetings.orgId, orgId))).length).toBe(0);
    expect((await db.select().from(docs).where(eq(docs.orgId, orgId))).filter((d) => !d.deletedAt).length).toBe(0);
  });

  it("exports through a link that expires, rate limits a second export, and the zip imports into a fresh workspace with the same counts", async () => {
    const a = await owner();
    for (const [name, rows] of [["Alpha", "Title,Status\nA1,To do\nA2,Done\n"], ["Beta", "Title,Status\nB1,Doing\n"]] as const) {
      expect((await a.c.post("/api/data-moves/imports/run", { kind: "tasks", content: rows, projectName: name })).status).toBe(200);
    }
    await a.c.post("/api/data-moves/imports/run", { kind: "contacts", content: fixture("contacts.vcf") });
    await a.c.post("/api/data-moves/imports/run", { kind: "calendar", content: fixture("calendar.ics") });
    await a.c.post("/api/data-moves/imports/run", { kind: "docs", content: "# Notes\n\nSome **bold** text" });
    const exp = await a.c.post("/api/data-moves/exports", {});
    expect(exp.status).toBe(200);
    expect(exp.body.counts).toMatchObject({ tasks: 3, contacts: 2, meetings: 3, docs: 1 });
    expect((await a.c.post("/api/data-moves/exports", {})).status).toBe(429);
    const raw = async (p: string) => a.app.request(p, { headers: { host: "localhost" } });
    const bad = await raw(exp.body.downloadPath.replace(/token=.*/, "token=nope"));
    expect(bad.status).toBe(404);
    const res = await raw(exp.body.downloadPath);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(bytes);
    for (const f of ["README.txt", "data/tasks.json", "csv/tasks.csv", "csv/contacts.csv", "contacts/contacts.vcf", "calendar/meetings.ics", "docs/Notes.md", "workspace.json"]) expect(Object.keys(files), f).toContain(f);
    expect(JSON.parse(strFromU8(files["data/tasks.json"]))).toHaveLength(3);
    expect(strFromU8(files["docs/Notes.md"])).toContain("Some **bold** text");
    expect(JSON.stringify(JSON.parse(strFromU8(files["data/meetings.json"])))).not.toContain("guestToken");
    const hist = (await a.c.get("/api/data-moves")).body.items[0];
    expect(hist.finishedAt).not.toBeNull();

    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    const b = await owner("second@other.io");
    const pre = await b.c.post("/api/data-moves/imports/preview", { kind: "workspace", fileName: "export.zip", content: ZIP_PREFIX + btoa(s) });
    expect(pre.body.parts).toEqual({ projects: 2, tasks: 3, meetings: 3, contacts: 2, docs: 1 });
    let run = await b.c.post("/api/data-moves/imports/run", { kind: "workspace", fileName: "export.zip", content: ZIP_PREFIX + btoa(s) });
    for (let i = 0; i < 5 && run.body.move.status !== "done"; i++) run = await b.c.post("/api/data-moves/imports/run", { kind: "workspace", content: ZIP_PREFIX + btoa(s), moveId: run.body.move.id });
    expect(run.body.move.status).toBe("done");
    const count = async (t: typeof tasks | typeof contacts | typeof meetings | typeof docs) => (await b.db.select().from(t).where(eq(t.orgId, b.orgId))).length;
    expect([await count(tasks), await count(contacts), await count(meetings), await count(docs)]).toEqual([3, 2, 3, 1]);
    const names = (await b.db.select({ n: projects.name }).from(projects).where(eq(projects.orgId, b.orgId))).map((p) => p.n).sort();
    expect(names).toEqual(expect.arrayContaining(["Alpha", "Beta"]));
    const done = (await b.db.select().from(tasks).where(eq(tasks.orgId, b.orgId))).find((t) => t.title === "A2");
    expect(done?.status).toBe("done");
  });

  it("only owners and admins can export, and an expired link answers 410", async () => {
    const a = await owner();
    const r = await a.c.post("/api/data-moves/exports", {});
    expect(r.status).toBe(200);
    expect(r.body.expiresAt).toBeTruthy();
    const later = new Date(Date.now() + 25 * 3600_000);
    a.deps.now = () => later;
    const res = await a.app.request(r.body.downloadPath, { headers: { host: "localhost" } });
    expect(res.status).toBe(410);
    const { startExport } = await import("@/server/services/data-move/service");
    await expect(startExport(a.deps, { orgId: a.orgId, userId: "u", email: "m@x.io", name: "M", role: "member" })).rejects.toMatchObject({ status: 403 });
  });
});
