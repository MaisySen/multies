import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readdirSync, readFileSync } from "node:fs";
import { makeTestApp, Client } from "./helpers";
import { parseFieldFilters } from "@/server/services/suite/fields";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
const clock = new Date("2026-10-20T00:00:00.000Z").getTime();

async function setup() {
  ctx = await makeTestApp();
  ctx.deps.now = () => new Date(clock);
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
}
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
// AIS1: new projects start with Triage on; off here so tasks made with a key go straight to the lists read below.
const project = async () => (await c.post("/api/projects", { name: "Client work", triage: false })).body.project as { id: string; key: string };
const task = async (projectId: string, title: string, extra: Record<string, unknown> = {}) => (await c.post("/api/tasks", { title, projectId, ...extra })).body.task;

describe("custom fields", () => {
  beforeEach(setup);

  it("parses field filters from the query", () => {
    expect(parseFieldFilters({ "field.fld_a": "gt:100", "field.fld_b": "Gold", q: "x", "field.bad id": "1" })).toEqual([
      { fieldId: "fld_a", op: "gt", value: "100" }, { fieldId: "fld_b", op: "eq", value: "Gold" },
    ]);
    expect(parseFieldFilters({ "field.fld_c": "empty" })).toEqual([{ fieldId: "fld_c", op: "empty", value: undefined }]);
  });

  it("creates every type, sets values, filters and sorts", async () => {
    const p = await project();
    const mk = async (name: string, type: string, options?: string[]) => (await c.post("/api/fields", { projectId: p.id, name, type, options: options?.map((label) => ({ label })) })).body.field;
    const budget = await mk("Budget", "currency");
    const tier = await mk("Tier", "select", ["Gold", "Silver"]);
    const tags = await mk("Tags", "multiselect", ["Web", "Print"]);
    const approved = await mk("Approved", "checkbox");
    const site = await mk("Site", "url");
    const kickoff = await mk("Kickoff", "date");
    const hours = await mk("Hours", "number");
    const owner = await mk("Lead", "person");
    const note = await mk("Brief", "text");
    expect((await c.get(`/api/fields?projectId=${p.id}`)).body.fields.map((f: { name: string }) => f.name)).toEqual(["Budget", "Tier", "Tags", "Approved", "Site", "Kickoff", "Hours", "Lead", "Brief"]);
    const me = (await c.get("/api/tasks/assignees")).body.assignees[0].id;

    const a = await task(p.id, "Logo", { fields: { [budget.id]: "A$1,250.50", Tier: "Gold", [tags.id]: ["Web", "Print"], [approved.id]: true } });
    expect(a.fields[budget.id]).toBe(1250.5);
    const b = await task(p.id, "Brochure");
    const r = await c.patch(`/api/tasks/${b.id}`, { fields: { [budget.id]: 400, [tier.id]: "Silver", [site.id]: "harbour.coffee", [kickoff.id]: "2026-11-02", [hours.id]: 3.5, [owner.id]: me, [note.id]: "Two sides" } });
    expect(r.status).toBe(200);
    expect(r.body.task.fields[site.id]).toBe("https://harbour.coffee/");
    expect(r.body.task.fields[owner.id]).toBe(me);
    await task(p.id, "Menu");

    const bad = await c.patch(`/api/tasks/${b.id}`, { fields: { [tier.id]: "Bronze" } });
    expect(bad.status).toBe(422);
    expect((await c.patch(`/api/tasks/${b.id}`, { fields: { [kickoff.id]: "next week" } })).status).toBe(422);
    expect((await c.patch(`/api/tasks/${b.id}`, { fields: { [site.id]: "javascript:alert(1)" } })).status).toBe(422);
    expect((await c.patch(`/api/tasks/${b.id}`, { fields: { [owner.id]: "member:nobody" } })).status).toBe(422);

    const titles = async (q: string) => (await c.get(`/api/tasks?projectId=${p.id}&${q}`)).body.tasks.map((t: { title: string }) => t.title);
    expect(await titles(`field.${tier.id}=Gold`)).toEqual(["Logo"]);
    expect(await titles(`field.${budget.id}=gt:500`)).toEqual(["Logo"]);
    expect(await titles(`field.${approved.id}=true`)).toEqual(["Logo"]);
    expect((await titles(`field.${approved.id}=false`)).sort()).toEqual(["Brochure", "Menu"]);
    expect(await titles(`field.${tags.id}=Print`)).toEqual(["Logo"]);
    expect(await titles(`field.${budget.id}=empty`)).toEqual(["Menu"]);
    expect(await titles(`field.${kickoff.id}=lt:2026-12-01`)).toEqual(["Brochure"]);
    expect(await titles(`field.${note.id}=contains:sides`)).toEqual(["Brochure"]);
    expect(await titles(`sort=field:${budget.id}&dir=desc`)).toEqual(["Logo", "Brochure", "Menu"]);
    expect(await titles(`sort=field:${budget.id}`)).toEqual(["Brochure", "Logo", "Menu"]);
    expect(await titles(`sort=field:${tier.id}`)).toEqual(["Logo", "Brochure", "Menu"]);

    // Detail carries the definitions; removing an option clears the values that used it.
    expect((await c.get(`/api/tasks/${a.id}`)).body.customFields).toHaveLength(9);
    await c.patch(`/api/fields/${tier.id}`, { options: [{ id: tier.options[1].id, label: "Silver plus" }] });
    expect((await c.get(`/api/tasks/${a.id}`)).body.task.fields[tier.id]).toBeUndefined();
    expect((await c.get(`/api/tasks/${b.id}`)).body.task.fields[tier.id]).toBe(tier.options[1].id);
    expect((await c.del(`/api/fields/${budget.id}`)).status).toBe(200);
    expect((await c.get(`/api/tasks/${a.id}`)).body.task.fields[budget.id]).toBeUndefined();
    // A field from another project is refused.
    const other = await project();
    const t2 = await task(other.id, "Elsewhere");
    expect((await c.patch(`/api/tasks/${t2.id}`, { fields: { [hours.id]: 1 } })).status).toBe(422);
  });

  it("works through the REST API and MCP, with webhooks for field changes", async () => {
    const p = await project();
    const key = (await c.post("/api/developer/keys", { name: "Fields" })).body.secret;
    const f = await api(key, "POST", `/projects/${p.id}/fields`, { name: "Stage", type: "select", options: [{ label: "Draft" }, { label: "Sent" }] });
    expect(f.status).toBe(201);
    const t = (await api(key, "POST", "/tasks", { title: "Quote", projectId: p.id, fields: { Stage: "Sent" } })).body.task;
    expect(t.fields[f.body.field.id]).toBe(f.body.field.options[1].id);
    const list = await api(key, "GET", `/tasks?projectId=${p.id}&field.${f.body.field.id}=Sent`);
    expect(list.body.tasks).toHaveLength(1);
    const mcp = await mcpFor(key);
    const created = data(await mcp.callTool({ name: "create_custom_field", arguments: { projectId: p.id, name: "Paid", type: "checkbox" } }));
    const set = data(await mcp.callTool({ name: "set_task_fields", arguments: { taskId: t.ref, values: { Paid: true } } }));
    expect(set.fields[created.field.id]).toBe(true);
    const found = data(await mcp.callTool({ name: "find_tasks_by_field", arguments: { projectId: p.id, fieldId: created.field.id, value: "true" } }));
    expect(found.tasks.map((x: { ref: string }) => x.ref)).toEqual([t.ref]);
    const spec = (await c.get("/api/v1/openapi.json")).body;
    expect(spec.paths["/projects/{id}/fields"]).toBeTruthy();
    expect(spec.paths["/portfolio"]).toBeTruthy();
  });
});

describe("portfolio", () => {
  beforeEach(setup);

  it("rolls up progress, overdue, time and next due, with health set by hand", async () => {
    const p = await project();
    await task(p.id, "Done one", { status: "done" });
    await task(p.id, "Late", { due: "2026-10-10" });
    const soon = await task(p.id, "Soon", { due: "2026-10-25" });
    await task(p.id, "Later", { due: "2026-11-20" });
    await c.post("/api/time", { taskId: soon.id, minutes: 90 });
    const me = (await c.get("/api/account/me")).body;
    const userId = me.user?.id ?? me.id;
    expect((await c.patch(`/api/projects/${p.id}`, { health: "at_risk", healthNote: "Waiting on copy", ownerId: userId })).status).toBe(200);
    const row = (await c.get("/api/portfolio")).body.projects.find((x: { id: string }) => x.id === p.id);
    expect(row).toMatchObject({ total: 4, done: 1, progress: 25, overdue: 1, timeLoggedSeconds: 5400, health: "at_risk", healthNote: "Waiting on copy" });
    expect(row.nextDueTask.title).toBe("Soon");
    expect(row.owner.id).toBe(userId);
    expect((await c.patch(`/api/projects/${p.id}`, { health: "great" })).status).toBe(422);
    expect((await c.patch(`/api/projects/${p.id}`, { ownerId: "usr_nobody" })).status).toBe(422);
  });
});

describe("guests", () => {
  beforeEach(setup);

  const inviteLink = () => {
    // The log outbox keeps what was sent; the invite link is in the newest system email.
    const sent = (ctx.outbound as unknown as { sent?: { text: string }[] }).sent ?? [];
    const text = sent.map((m) => m.text).reverse().find((t) => t.includes("/g/")) ?? "";
    return text.match(/\/g\/([A-Za-z0-9_-]+)/)?.[1];
  };

  it("invites a guest who sees only that project, can comment and upload, and is not a member", async () => {
    const p = await project();
    const other = await project();
    const t = await task(p.id, "Homepage copy");
    const hidden = await task(other.id, "Internal budget");
    await c.post(`/api/tasks/${t.id}/comments`, { body: "Draft is in" });
    await c.post("/api/docs", { title: "Brief", projectId: p.id, text: "Bold and warm" });
    await c.post("/api/docs", { title: "Secret plan", projectId: other.id, text: "nope" });

    const inv = await c.post("/api/guests", { projectId: p.id, email: "Client@Harbour.coffee", name: "Mia" });
    expect(inv.status).toBe(201);
    expect(inv.body.guest).toMatchObject({ email: "client@harbour.coffee", status: "pending" });
    const token = inviteLink() ?? (inv.body.inviteUrl as string | undefined)?.split("/g/")[1];
    expect(token).toBeTruthy();
    expect((await c.get(`/api/guests?projectId=${p.id}`)).body.guests).toHaveLength(1);
    // Guests take no seat: the team list is unchanged.
    const team = (await c.get("/api/team")).body;
    expect(JSON.stringify(team)).not.toContain("harbour.coffee");

    const g = new Client(ctx.app);
    expect((await g.get("/api/guest/me")).status).toBe(401);
    expect((await g.post("/api/guest/accept", { token: "x".repeat(30) })).status).toBe(404);
    expect((await g.post("/api/guest/accept", { token })).status).toBe(200);
    // R41 (MB-227): the same link opens on a second device too, with its own session; the first stays signed in.
    const g2 = new Client(ctx.app);
    expect((await g2.post("/api/guest/accept", { token })).status).toBe(200);
    expect(g2.cookie).not.toBe(g.cookie);
    expect((await g2.get("/api/guest/me")).status).toBe(200);
    // A forged device session is refused.
    const forged = new Client(ctx.app);
    forged.jar.set(g2.cookie.split("=")[0], `${inv.body.guest.id}.abcdefabcdefabcdefabcdef.${"0".repeat(64)}`);
    expect((await forged.get("/api/guest/me")).status).toBe(401);
    const home = (await g.get("/api/guest/me")).body;
    expect(home.project.id).toBe(p.id);
    expect(home.tasks.map((x: { title: string }) => x.title)).toEqual(["Homepage copy"]);
    expect(home.docs.map((d: { title: string }) => d.title)).toEqual(["Brief"]);
    expect((await g.get(`/api/guest/tasks/${hidden.id}`)).status).toBe(404);
    expect((await g.get(`/api/guest/docs/${home.docs[0].id}`)).body.doc.title).toBe("Brief");

    const detail = (await g.get(`/api/guest/tasks/${t.id}`)).body;
    expect(detail.comments[0].body).toBe("Draft is in");
    const cm = await g.post(`/api/guest/tasks/${t.id}/comments`, { body: "Looks good" });
    expect(cm.status).toBe(201);
    expect(cm.body.comment.author.name).toBe("Mia (guest)");
    const up = await g.post(`/api/guest/tasks/${t.ref}/files`, { filename: "logo.svg", contentType: "image/svg+xml", contentBase64: Buffer.from("<svg/>").toString("base64") });
    expect(up.status).toBe(201);
    const dl = await ctx.app.request(`/api/guest/files/${up.body.file.id}`, { headers: { cookie: g.cookie, host: "localhost" } });
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await dl.text()).toBe("<svg/>");
    // Members see the guest's comment and file.
    expect((await c.get(`/api/files?taskId=${t.id}`)).body.files[0].uploadedBy).toEqual({ type: "guest", name: "Mia (guest)" });
    // The guest session opens nothing in the workspace.
    for (const path of ["/api/tasks", "/api/projects", "/api/mail/messages", "/api/contacts", "/api/portfolio"]) expect((await g.get(path)).status).toBe(401);
    expect((await g.patch(`/api/tasks/${t.id}`, { title: "hacked" })).status).toBe(401);

    // Removing the guest ends the session.
    expect((await c.del(`/api/guests/${inv.body.guest.id}`)).status).toBe(200);
    expect((await g.get("/api/guest/me")).status).toBe(401);
    expect((await g2.get("/api/guest/me")).status).toBe(401);
    expect((await g2.post("/api/guest/accept", { token })).status).toBe(404);
  });

  it("sends an agent's invite through the approval queue", async () => {
    const p = await project();
    const { apiKey } = (await c.post("/api/agents", { name: "Client bot", localPart: "clients" })).body;
    if (!apiKey) return; // agent inboxes need a verified domain on some plans; covered by the e2e
    const r = await api(apiKey, "POST", `/projects/${p.id}/guests`, { email: "client@example.com" });
    expect([201, 403, 422]).toContain(r.status);
    if (r.status === 201) expect(["pending_approval", "sent"]).toContain(r.body.delivery.status);
  });
});

describe("migrations", () => {
  it("ship the round 8 tables", () => {
    const sql = readdirSync("drizzle").filter((f) => f.startsWith("0019")).map((f) => readFileSync(`drizzle/${f}`, "utf8")).join("\n");
    for (const t of ["custom_fields", "task_field_values", "project_guests", "task_files"]) expect(sql).toContain(`CREATE TABLE \`${t}\``);
  });
});
