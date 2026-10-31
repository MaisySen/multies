import { describe, it, expect, beforeEach } from "vitest";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { makeTestApp, Client } from "./helpers";
import { createTask } from "@/server/services/suite/tasks";
import type { SuiteActor } from "@/server/services/suite/common";
import { compileQuestion, QuestionSpec, runOnRows, type QScope } from "@/server/services/suite/dash-r91-question";
import { evaluate, inQuiet, runDueAlerts } from "@/server/services/suite/dash-r91-alerts";
import { nextRunAt, runDueReports } from "@/server/services/suite/dash-r91-reports";
import { checkCsvUrl, parseCsv } from "@/server/services/suite/dash-r91-sources";
import { isActive, scrub } from "@/server/services/suite/dash-r91-share";
import { summarise } from "@/server/services/suite/dash-r91-common";

const dialect = new SQLiteSyncDialect();
const scope = (o: Partial<QScope> = {}): QScope => ({ orgId: "org_a", userId: "usr_a", admin: false, mailboxes: ["mbx_1"], now: Date.parse("2026-11-04T02:00:00Z"), offsetMin: 600, ...o });
const q = (o: Record<string, unknown>) => QuestionSpec.parse(o);
const compiled = (o: Record<string, unknown>, s = scope()) => dialect.sqlToQuery(compileQuestion(q(o), s).query);

describe("R91 question builder to SQL", () => {
  it("binds every value as a parameter and always scopes to the workspace", () => {
    const r = compiled({ table: "tasks", filters: [{ field: "title", op: "contains", value: "'; drop table tasks; --" }], groupBy: "status", measure: { op: "count" } });
    expect(r.sql).not.toContain("drop table");
    expect(r.params).toContain("'; drop table tasks; --");
    expect(r.params).toContain("org_a");
    expect(r.sql).toMatch(/"org_id" = \?/);
    expect(r.sql).toMatch(/limit \?$/);
  });
  it("time entries: a member sees only their own, an admin sees everyone", () => {
    expect(compiled({ table: "time", measure: { op: "sum", field: "hours" } }).params).toContain("usr_a");
    expect(compiled({ table: "time", measure: { op: "sum", field: "hours" } }, scope({ admin: true })).params).not.toContain("usr_a");
  });
  it("bookings: a member sees only their own booking pages", () => {
    const r = compiled({ table: "bookings" });
    expect(r.sql).toContain("scheduling_pages");
    expect(r.params).toContain("usr_a");
  });
  it("mail volume reads only the mailboxes the viewer may read, and nothing when none", () => {
    expect(compiled({ table: "mail" }).params).toContain("mbx_1");
    expect(compiled({ table: "mail" }, scope({ mailboxes: [] })).sql).toMatch(/and 0/);
  });
  it("refuses unknown fields, sums of text and measures on count only tables", () => {
    expect(() => compiled({ table: "tasks", groupBy: "notes" })).toThrow(/Unknown field/);
    expect(() => compiled({ table: "tasks", measure: { op: "sum", field: "title" } })).toThrow(/isn't a number/);
    expect(() => compiled({ table: "forms", measure: { op: "sum", field: "form" } })).toThrow(/only be counted/);
    expect(() => compiled({ table: "tasks", filters: [{ field: "status", op: "is", value: "maybe" }] })).toThrow(/isn't a status/);
    expect(() => compiled({ table: "tasks", filters: [{ field: "due", op: "last_days", value: "0" }] })).toThrow(/days/);
    expect(() => QuestionSpec.parse({ table: "users" })).toThrow();
  });
  it("buckets dates in the viewer's zone and orders buckets by date", () => {
    const r = compiled({ table: "deals", groupBy: "created", bucket: "month", measure: { op: "sum", field: "value" } });
    expect(r.sql).toContain("strftime('%Y-%m'");
    expect(r.params).toContain(36000);
    expect(r.sql).toMatch(/order by g asc/);
  });
});

describe("R91 aggregation on uploaded rows", () => {
  const cols = [{ name: "Region", kind: "text" as const }, { name: "Sales", kind: "number" as const }, { name: "Day", kind: "date" as const }];
  const rows = [["North", 10, "2026-10-26"], ["South", 5, "2026-10-27"], ["North", 7.5, "2026-11-02"], ["East", null, "2026-11-03"]];
  it("counts, sums, averages, min and max, with filters", () => {
    expect(runOnRows(q({ table: "source", measure: { op: "count" } }), cols, rows, 0, Date.now()).value).toBe(4);
    expect(runOnRows(q({ table: "source", measure: { op: "sum", field: "Sales" } }), cols, rows, 0, Date.now()).value).toBe(22.5);
    expect(runOnRows(q({ table: "source", measure: { op: "avg", field: "Sales" } }), cols, rows, 0, Date.now()).value).toBe(7.5);
    expect(runOnRows(q({ table: "source", measure: { op: "max", field: "Sales" } }), cols, rows, 0, Date.now()).value).toBe(10);
    expect(runOnRows(q({ table: "source", filters: [{ field: "Region", op: "is", value: "North" }], measure: { op: "sum", field: "Sales" } }), cols, rows, 0, Date.now()).value).toBe(17.5);
  });
  it("groups by text (largest first) and by week (in date order)", () => {
    expect(runOnRows(q({ table: "source", groupBy: "Region", measure: { op: "sum", field: "Sales" } }), cols, rows, 0, Date.now()).rows).toEqual([{ label: "North", value: 17.5 }, { label: "South", value: 5 }, { label: "East", value: 0 }]);
    expect(runOnRows(q({ table: "source", groupBy: "Day", bucket: "week" }), cols, rows, 0, Date.now()).rows).toEqual([{ label: "2026-10-26", value: 2 }, { label: "2026-11-02", value: 2 }]);
  });
  it("refuses a missing column", () => {
    expect(() => runOnRows(q({ table: "source", groupBy: "Nope" }), cols, rows, 0, Date.now())).toThrow(/no column/);
  });
});

describe("R91 alert crossing", () => {
  it("fires once per crossing and rearms when the number comes back", () => {
    let s = { state: null as "ok" | "crossed" | null, pending: false };
    const step = (v: number, quiet = false) => { const r = evaluate(s, v, 10, "above", quiet); s = { state: r.state, pending: r.pending }; return r.fire; };
    expect(step(5)).toBe(false);
    expect(step(11)).toBe(true);
    expect(step(12)).toBe(false);
    expect(step(13)).toBe(false);
    expect(step(10)).toBe(false); // back at the line: rearmed
    expect(step(11)).toBe(true);
  });
  it("holds a crossing during quiet hours and sends it when they end, if still crossed", () => {
    let s = { state: "ok" as "ok" | "crossed" | null, pending: false };
    const step = (v: number, quiet: boolean) => { const r = evaluate(s, v, 3, "below", quiet); s = { state: r.state, pending: r.pending }; return r.fire; };
    expect(step(1, true)).toBe(false);
    expect(s.pending).toBe(true);
    expect(step(1, true)).toBe(false);
    expect(step(2, false)).toBe(true);
    expect(step(2, false)).toBe(false);
    expect(step(1, true)).toBe(false);
    expect(step(5, true)).toBe(false); // recovered in quiet hours: nothing owed
    expect(s.pending).toBe(false);
  });
  it("quiet hours wrap past midnight", () => {
    expect(inQuiet(23, 22, 7)).toBe(true);
    expect(inQuiet(3, 22, 7)).toBe(true);
    expect(inQuiet(7, 22, 7)).toBe(false);
    expect(inQuiet(12, 9, 17)).toBe(true);
    expect(inQuiet(12, null, null)).toBe(false);
  });
});

describe("R91 report schedule", () => {
  const at = (iso: string) => Date.parse(iso);
  it("daily at 8 in Sydney", () => {
    expect(new Date(nextRunAt({ frequency: "daily", hour: 8, timeZone: "Australia/Sydney" }, at("2026-10-31T12:00:00Z"))).toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(new Date(nextRunAt({ frequency: "daily", hour: 8, timeZone: "Australia/Sydney" }, at("2026-10-31T21:00:00Z"))).toISOString()).toBe("2026-11-01T21:00:00.000Z");
  });
  it("weekly on Monday (0) and monthly on the 31st falls to the last day of a short month", () => {
    expect(new Date(nextRunAt({ frequency: "weekly", hour: 9, weekday: 0, timeZone: "UTC" }, at("2026-11-04T10:00:00Z"))).toISOString()).toBe("2026-11-09T09:00:00.000Z");
    expect(new Date(nextRunAt({ frequency: "monthly", hour: 6, monthDay: 31, timeZone: "UTC" }, at("2026-11-04T10:00:00Z"))).toISOString()).toBe("2026-11-30T06:00:00.000Z");
  });
  it("keeps the local hour across a daylight saving change", () => {
    // Sydney moves to +11 on 4 Oct 2026: 8 am is 22:00 UTC before and 21:00 UTC after.
    expect(new Date(nextRunAt({ frequency: "daily", hour: 8, timeZone: "Australia/Sydney" }, at("2026-10-01T23:00:00Z"))).toISOString()).toBe("2026-10-02T22:00:00.000Z");
    expect(new Date(nextRunAt({ frequency: "daily", hour: 8, timeZone: "Australia/Sydney" }, at("2026-10-04T23:00:00Z"))).toISOString()).toBe("2026-10-05T21:00:00.000Z");
  });
});

describe("R91 CSV links and files", () => {
  it("refuses private, local, credentialed, http and odd port links", () => {
    for (const u of ["http://example.com/a.csv", "https://127.0.0.1/a.csv", "https://10.0.0.8/a.csv", "https://192.168.1.2/a.csv", "https://169.254.169.254/latest", "https://[::1]/a.csv",
      "https://localhost/a.csv", "https://printer.local/a.csv", "https://u:p@example.com/a.csv", "https://example.com:8443/a.csv", "https://2130706433/a.csv", "not a url"]) expect(() => checkCsvUrl(u), u).toThrow();
  });
  it("turns a sheet share link into its CSV export and keeps other links", () => {
    expect(checkCsvUrl("https://docs.google.com/spreadsheets/d/AbC_12-x/edit#gid=42")).toBe("https://docs.google.com/spreadsheets/d/AbC_12-x/export?format=csv&gid=42");
    expect(checkCsvUrl("https://example.com/data.csv?x=1")).toBe("https://example.com/data.csv?x=1");
  });
  it("parses a header, infers number and date columns, and enforces caps", () => {
    const p = parseCsv("\ufeffName,Amount,When\nA,\"1,200\",2026-10-01\nB,$30,2026-10-02\n");
    expect(p.columns).toEqual([{ name: "Name", kind: "text" }, { name: "Amount", kind: "number" }, { name: "When", kind: "date" }]);
    expect(p.rows[0]).toEqual(["A", 1200, "2026-10-01"]);
    expect(() => parseCsv("only,a,header\n")).toThrow(/header row/);
    expect(() => parseCsv(`${Array.from({ length: 31 }, (_, i) => `c${i}`).join(",")}\n${"1,".repeat(30)}1\n`)).toThrow(/30 columns/);
    expect(() => parseCsv(`a\n${"1\n".repeat(5001)}`)).toThrow(/rows/);
  });
});

describe("R91 share helpers", () => {
  it("a link is active until revoked or expired", () => {
    const now = Date.now();
    expect(isActive({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(isActive({ revokedAt: null, expiresAt: new Date(now - 1) }, now)).toBe(false);
    expect(isActive({ revokedAt: new Date(now), expiresAt: null }, now)).toBe(false);
  });
  it("scrub drops ids and emails but keeps names and numbers", () => {
    expect(scrub({ rows: [{ id: "tsk_1", assigneeId: "usr_1", label: "Ada", email: "ada@x.io", value: 3, by: "bob@acme.io" }] })).toEqual({ rows: [{ label: "Ada", value: 3, by: "bob" }] });
  });
  it("summarise reads numbers and the top groups", () => {
    expect(summarise("Open", { value: 1234 }).value).toBe("1,234");
    expect(summarise("By status", { groups: [{ label: "Done", count: 2 }] }).rows).toEqual([{ label: "Done", value: "2" }]);
    expect(summarise("Odd", { x: 1 }).value).toMatch(/Open the dashboard/);
  });
});

describe("R91 routes end to end", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let c: Client;
  let m: Client;
  let actor: SuiteActor;
  let dash: string;
  beforeEach(async () => {
    ctx = await makeTestApp({ DASHBOARDS_PLUS: "on", APP_URL: "https://app.test" });
    c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    const me = (await c.get("/api/account/me")).body;
    actor = { orgId: me.organization.id, userId: me.user.id, email: me.user.email, name: me.user.name, role: "owner" };
    const invite = await c.post("/api/team/invites", { email: "max@acme.io", role: "member" });
    m = new Client(ctx.app);
    await m.signup("max@acme.io", "Max Member", "");
    await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`);
    const p = (await c.post("/api/projects", { name: "Launch", key: "LAU" })).body.project.id;
    for (const t of ["One", "Two", "Three"]) await createTask(ctx.deps, actor, { title: t, projectId: p });
    dash = (await c.post("/api/dashboards", { name: "Ops", shared: true, widgets: [{ type: "count" }, { type: "question", question: { table: "tasks", groupBy: "status" } }] })).body.dashboard.id;
  }, 60_000);

  it("is off without the flag", async () => {
    const off = await makeTestApp();
    const oc = new Client(off.app);
    await oc.signup("o@x.io");
    expect((await oc.get("/api/dashboards-plus/question/catalog")).status).toBe(404);
    expect((await oc.get("/api/dash-public/abc")).status).toBe(404);
  });

  it("a question card computes on the dashboard, and the preview answers", async () => {
    const d = (await c.get(`/api/dashboards/${dash}/data`)).body;
    expect(d.widgets[1].data.rows).toEqual([{ label: "To do", value: 3 }]);
    expect((await c.post("/api/dashboards-plus/question/preview", { question: { table: "tasks" } })).body.result.value).toBe(3);
    expect((await c.post("/api/dashboards", { name: "Bad", widgets: [{ type: "question" }] })).status).toBe(422);
  });

  it("share link: opens logged out, needs its password, expires and revokes; members cannot make one", async () => {
    expect((await m.post(`/api/dashboards-plus/${dash}/shares`, {})).status).toBe(403);
    const s = (await c.post(`/api/dashboards-plus/${dash}/shares`, { password: "secret12", expiresInDays: 7 })).body;
    const token = s.url.split("/d/")[1];
    const anon = new Client(ctx.app);
    expect((await anon.get(`/api/dash-public/${token}`)).body.error.code).toBe("password_required");
    expect((await anon.call("GET", `/api/dash-public/${token}`, undefined, { "x-share-password": "nope" })).status).toBe(401);
    const ok = await anon.call("GET", `/api/dash-public/${token}`, undefined, { "x-share-password": "secret12" });
    expect(ok.status).toBe(200);
    expect(ok.body.dashboard.name).toBe("Ops");
    expect(ok.body.dashboard.brand).toBe("Acme");
    const leak = JSON.stringify(ok.body).match(/owner@acme\.io|usr_\w+|"source":|"question":\{/);
    expect(leak?.[0] ?? null).toBeNull();
    const later = Date.now() + 8 * 86_400_000;
    ctx.deps.now = () => new Date(later);
    expect((await anon.call("GET", `/api/dash-public/${token}`, undefined, { "x-share-password": "secret12" })).status).toBe(404);
    ctx.deps.now = () => new Date();
    const s2 = (await c.post(`/api/dashboards-plus/${dash}/shares`, { expiresInDays: null })).body;
    expect((await anon.get(`/api/dash-public/${s2.url.split("/d/")[1]}`)).status).toBe(200);
    expect((await c.del(`/api/dashboards-plus/shares/${s2.link.id}`)).status).toBe(200);
    expect((await anon.get(`/api/dash-public/${s2.url.split("/d/")[1]}`)).status).toBe(404);
  });

  it("scheduled report: mails each recipient once per run with unsubscribe, and stops after unsubscribe", async () => {
    const r = (await c.post(`/api/dashboards-plus/${dash}/reports`, { frequency: "daily", hour: 8, timeZone: "UTC", recipients: [{ email: "client@outside.io" }, { email: "x@y.io", userId: actor.userId }] })).body.report;
    expect(r.recipients.map((x: { email: string }) => x.email).sort()).toEqual(["client@outside.io", "owner@acme.io"]);
    const sentBefore = ctx.outbound.sent.length;
    ctx.deps.now = () => new Date(Date.parse(r.nextRunAt) + 1000);
    await runDueReports(ctx.deps);
    await runDueReports(ctx.deps); // claimed: no second send
    const mails = ctx.outbound.sent.slice(sentBefore);
    expect(mails.length).toBe(2);
    const outside = mails.find((x) => JSON.stringify(x.to).includes("client@outside.io"))!;
    const text = String(outside.text ?? "");
    expect(text).toContain("Ops");
    expect(text).toMatch(/https:\/\/app\.test\/d\//);
    const unsub = text.match(/https:\/\/app\.test(\/api\/dash-public\/reports\/unsubscribe\?\S+)/)![1]!;
    expect((await new Client(ctx.app).get(unsub)).status).toBe(200);
    const pdf = text.match(/https:\/\/app\.test(\/api\/dash-public\/\S+\/pdf)/)![1]!;
    const pr = await ctx.app.request(pdf);
    expect(pr.headers.get("content-type")).toBe("application/pdf");
    const day2 = Date.parse(r.nextRunAt) + 86_400_000 + 1000;
    ctx.deps.now = () => new Date(day2);
    const n = ctx.outbound.sent.length;
    await runDueReports(ctx.deps);
    expect(ctx.outbound.sent.slice(n).map((x) => JSON.stringify(x.to)).join()).not.toContain("client@outside.io");
    expect((await m.post(`/api/dashboards-plus/${dash}/reports`, { frequency: "daily", recipients: [{ email: "a@b.io" }] })).status).toBe(403);
  });

  it("alert fires once per crossing, in the app and by mail", async () => {
    const d = (await c.get(`/api/dashboards/${dash}`)).body.dashboard;
    const count = d.widgets[0].id;
    expect((await c.post(`/api/dashboards-plus/${dash}/alerts`, { widgetId: d.widgets[1].id, direction: "above", threshold: 1 })).status).toBe(422);
    expect((await c.post(`/api/dashboards-plus/${dash}/alerts`, { widgetId: count, direction: "above", threshold: 2, quietStart: null, quietEnd: null })).status).toBe(201);
    const before = ctx.outbound.sent.length;
    await runDueAlerts(ctx.deps);
    const t1 = Date.now() + 16 * 60_000;
    ctx.deps.now = () => new Date(t1);
    await runDueAlerts(ctx.deps);
    const alerts = ctx.outbound.sent.slice(before).filter((x) => String(x.subject).startsWith("Alert:"));
    expect(alerts.length).toBe(1);
    const notes = (await c.get("/api/notifications")).body;
    expect(JSON.stringify(notes)).toContain("is above 2");
  });

  it("data sources: upload a CSV and ask a question of it", async () => {
    const s = (await c.post("/api/dashboards-plus/sources", { kind: "csv", name: "Sales", csv: "Region,Sales\nNorth,10\nSouth,5\nNorth,2\n" })).body.source;
    expect(s.rowCount).toBe(3);
    const r = (await c.post("/api/dashboards-plus/question/preview", { question: { table: "source", sourceId: s.id, groupBy: "Region", measure: { op: "sum", field: "Sales" } } })).body.result;
    expect(r.rows).toEqual([{ label: "North", value: 12 }, { label: "South", value: 5 }]);
    expect((await c.post("/api/dashboards-plus/sources", { kind: "url", name: "Bad", url: "https://10.0.0.1/x.csv" })).status).toBe(422);
    expect((await m.del(`/api/dashboards-plus/sources/${s.id}`)).status).toBe(403);
  });
});
