import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { eq } from "drizzle-orm";
import { formSubmissions, forms } from "@/server/db/schema";
import { csvCell, RESULTS_PAGE } from "@/server/services/suite/form-results";

/** R31: form logic (show if, rules) end to end, and the results view (responses, summary, CSV, MCP). */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let key: string;

async function v1(method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const fields = [
  { id: "name", label: "Your name", type: "text", required: true },
  { id: "email", label: "Email", type: "email", required: true },
  { id: "rush", label: "Is it urgent?", type: "select", options: ["Yes", "No"], required: true },
  { id: "why", label: "Why is it urgent?", type: "textarea", required: true, rules: { minLength: 5 }, logic: { join: "all", conditions: [{ field: "rush", op: "is", value: "Yes" }] } },
  { id: "seats", label: "Seats", type: "number", rules: { min: 1, max: 50 } },
  { id: "tools", label: "Tools you use", type: "multiselect", options: ["Mail", "Tasks", "Docs"], rules: { minSelected: 1 } },
];

beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  key = (await c.post("/api/developer/keys", { name: "Forms" })).body.secret;
});

async function makeForm() {
  const made = await c.post("/api/forms", { name: "Quote request", fields });
  expect(made.status).toBe(201);
  return made.body.form;
}

describe("form logic", () => {
  it("saves logic and rules, hides the question until the answer matches, and answers 400 with every field's error", async () => {
    const form = await makeForm();
    expect(form.fields[3].logic).toEqual({ join: "all", conditions: [{ field: "rush", op: "is", value: "Yes" }] });
    expect(form.fields[5].type).toBe("multiselect");
    const pub = new Client(ctx.app);
    expect((await pub.get(`/api/public/forms/${form.slug}`)).body.form.fields[3].logic.conditions[0].field).toBe("rush");
    const base = { name: "Grace", email: "grace@harbour.io" };
    // Hidden: not required, and a stray answer is dropped.
    const no = await pub.post(`/api/public/forms/${form.slug}`, { answers: { ...base, rush: "No", why: "ignored", tools: ["Docs", "Mail"] }, elapsedMs: 5000 });
    expect(no.status).toBe(200);
    // Shown: required and its rules apply; every error comes back at once.
    const bad = await pub.post(`/api/public/forms/${form.slug}`, { answers: { ...base, email: "nope", rush: "Yes", why: "abc", seats: "99" }, elapsedMs: 5000 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation_failed");
    expect(bad.body.error.details.field).toBe("email");
    expect(bad.body.error.details.fields).toEqual({
      email: '"Email" doesn\'t look like an email address.', why: '"Why is it urgent?" needs at least 5 characters.', seats: '"Seats" should be 50 or less.',
    });
    const ok = await pub.post(`/api/public/forms/${form.slug}`, { answers: { ...base, rush: "Yes", why: "Launch on Friday", seats: "12", tools: ["Tasks"] }, elapsedMs: 5000 });
    expect(ok.status).toBe(200);
    const list = await c.get(`/api/forms/${form.id}/responses`);
    expect(list.body.total).toBe(2);
    const first = list.body.responses.find((r: { answers: Record<string, string> }) => r.answers.rush === "No");
    expect(first.answers).toEqual({ name: "Grace", email: "grace@harbour.io", rush: "No", tools: "Mail, Docs" });
  });

  it("refuses loops and conditions on later questions, and drops conditions on deleted questions", async () => {
    const later = await c.post("/api/forms", { name: "Bad", fields: [{ id: "a", label: "A", type: "text", logic: { conditions: [{ field: "b", op: "answered" }] } }, { id: "b", label: "B", type: "text" }] });
    expect(later.status).toBe(422);
    expect(later.body.error.details.code).toBe("later");
    const self = await c.post("/api/forms", { name: "Bad", fields: [{ id: "a", label: "A", type: "text", logic: { conditions: [{ field: "a", op: "answered" }] } }] });
    expect(self.body.error.details.code).toBe("self");
    const form = await makeForm();
    const without = form.fields.filter((f: { id: string }) => f.id !== "rush");
    const saved = await c.patch(`/api/forms/${form.id}`, { fields: without });
    expect(saved.status).toBe(200);
    expect(saved.body.form.fields.find((f: { id: string }) => f.id === "why").logic).toBeUndefined();
  });

  it("sets one question's logic over the session API and v1, with the same checks", async () => {
    const form = await makeForm();
    const set = await c.put(`/api/forms/${form.id}/fields/seats/logic`, { logic: { join: "any", conditions: [{ field: "rush", op: "is", value: "Yes" }] }, rules: { min: 2 }, required: true });
    expect(set.status).toBe(200);
    expect(set.body.field).toMatchObject({ id: "seats", required: true, rules: { min: 2 }, logic: { join: "any" } });
    const loop = await v1("PUT", `/forms/${form.id}/fields/rush/logic`, { logic: { conditions: [{ field: "seats", op: "answered" }] } });
    expect(loop.status).toBe(422);
    expect(loop.body.error.details.code).toBe("cycle");
    const cleared = await v1("PUT", `/forms/${form.id}/fields/seats/logic`, { logic: null, rules: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.field.logic).toBeUndefined();
    expect(cleared.body.field.rules).toBeUndefined();
    expect((await v1("PUT", `/forms/${form.id}/fields/nope/logic`, { required: true })).status).toBe(404);
    const readKey = (await c.post("/api/developer/keys", { name: "Read", scope: "read" })).body.secret;
    const ro = await ctx.app.request(`/api/v1/forms/${form.id}/fields/seats/logic`, { method: "PUT", headers: { authorization: `Bearer ${readKey}`, host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ required: true }) });
    expect(ro.status).toBe(403);
  });
});

describe("form routing", () => {
  it("routes the task to the first matching rule's project and person, and checks rules on save", async () => {
    const projects = (await c.get("/api/projects")).body.projects as { id: string; name: string }[];
    const urgentProject = (await c.post("/api/projects", { name: "Urgent desk" })).body.project as { id: string };
    const me = (await c.get("/api/members")).body.members?.[0] ?? null;
    const routing = [{ when: { field: "rush", op: "is", value: "Yes" }, projectId: urgentProject.id, assigneeId: me ? `member:${me.userId ?? me.id}` : null }];
    const made = await c.post("/api/forms", { name: "Routed", fields, routing });
    expect(made.status).toBe(201);
    expect(made.body.form.routing).toHaveLength(1);
    const pub = new Client(ctx.app);
    const base = { name: "Grace", email: "g@x.io", tools: ["Mail"] };
    const yes = await pub.post(`/api/public/forms/${made.body.form.slug}`, { answers: { ...base, rush: "Yes", why: "Today please" }, elapsedMs: 5000 });
    const no = await pub.post(`/api/public/forms/${made.body.form.slug}`, { answers: { ...base, rush: "No" }, elapsedMs: 5000 });
    const tYes = (await c.get(`/api/tasks/${yes.body.created.id}`)).body.task;
    const tNo = (await c.get(`/api/tasks/${no.body.created.id}`)).body.task;
    expect(tYes.projectId).toBe(urgentProject.id);
    expect(tNo.projectId).not.toBe(urgentProject.id);
    void projects;
    // A rule on a removed question goes with it; a rule with nothing to do, or another workspace's project, is refused.
    const without = made.body.form.fields.filter((f: { id: string }) => f.id !== "rush" && f.id !== "why");
    expect((await c.patch(`/api/forms/${made.body.form.id}`, { fields: without })).body.form.routing).toEqual([]);
    expect((await c.post("/api/forms", { name: "Bad", fields, routing: [{ when: { field: "rush", op: "is", value: "Yes" } }] })).status).toBe(422);
    expect((await c.post("/api/forms", { name: "Bad", fields, routing: [{ when: { field: "rush", op: "is", value: "Yes" }, projectId: "prj_nope" }] })).status).toBe(404);
  });
});

describe("form results", () => {
  async function seed(formId: string, orgId: string, n: number, start = Date.parse("2026-10-01T00:00:00Z")) {
    for (let i = 0; i < n; i++) {
      const at = new Date(start + i * 60_000);
      await ctx.deps.db.insert(formSubmissions).values({
        id: `fsb_${String(i).padStart(6, "0")}`, orgId, formId, entityType: "task", entityId: `tsk_${i}`, ipHash: "x", createdAt: at,
        data: JSON.stringify({ name: i % 2 ? `Ana ${i}` : `Ben ${i}`, email: `p${i}@x.io`, rush: i % 3 ? "No" : "Yes", seats: String(i % 10 + 1), tools: i % 2 ? "Mail, Docs" : "Tasks" }),
      });
    }
  }

  it("pages, sorts, searches and filters by day; the summary reads every page", async () => {
    const form = await makeForm();
    const org = (await ctx.deps.db.select({ orgId: forms.orgId }).from(forms).where(eq(forms.id, form.id)).get())!.orgId;
    const n = RESULTS_PAGE + 120;
    await seed(form.id, org, n);
    const page = await c.get(`/api/forms/${form.id}/responses?limit=25`);
    expect(page.body.total).toBe(n);
    expect(page.body.responses).toHaveLength(25);
    expect(page.body.responses[0].id).toBe(`fsb_${String(n - 1).padStart(6, "0")}`);
    const next = await c.get(`/api/forms/${form.id}/responses?limit=25&offset=25`);
    expect(next.body.responses[0].id).toBe(`fsb_${String(n - 26).padStart(6, "0")}`);
    const bySeats = await c.get(`/api/forms/${form.id}/responses?sort=seats&dir=desc&limit=3`);
    expect(bySeats.body.responses.map((r: { answers: { seats: string } }) => r.answers.seats)).toEqual(["10", "10", "10"]);
    expect((await c.get(`/api/forms/${form.id}/responses?sort=evil`)).status).toBe(422);
    const found = await c.get(`/api/forms/${form.id}/responses?q=ana%2011`);
    expect(found.body.responses.map((r: { answers: { name: string } }) => r.answers.name)).toContain("Ana 11");
    expect((await c.get(`/api/forms/${form.id}/responses?q=100%25`)).body.total).toBe(0);
    const day = await c.get(`/api/forms/${form.id}/responses?from=2026-10-01&to=2026-10-01`);
    expect(day.body.total).toBe(n); // all seeded on the 1st (620 minutes)
    expect((await c.get(`/api/forms/${form.id}/responses?from=2026-10-02`)).body.total).toBe(0);
    expect((await c.get(`/api/forms/${form.id}/responses?from=yesterday`)).status).toBe(422);

    const s = (await c.get(`/api/forms/${form.id}/summary`)).body;
    expect(s.total).toBe(n);
    const rush = s.questions.find((x: { id: string }) => x.id === "rush");
    const yes = Math.ceil(n / 3);
    expect(rush.counts).toEqual([{ option: "Yes", count: yes }, { option: "No", count: n - yes }]);
    const tools = s.questions.find((x: { id: string }) => x.id === "tools");
    expect(tools.counts).toEqual([{ option: "Mail", count: n / 2 }, { option: "Tasks", count: n / 2 }, { option: "Docs", count: n / 2 }]);
    const seats = s.questions.find((x: { id: string }) => x.id === "seats");
    expect(seats).toMatchObject({ kind: "number", min: 1, max: 10, average: 5.5 });
    const name = s.questions.find((x: { id: string }) => x.id === "name");
    expect(name.kind).toBe("text");
    expect(name.latest).toHaveLength(5);
    expect(name.latest[0].answer).toBe(`Ana ${n - 1}`);
  });

  it("exports CSV with a header row and defused formulas, and stays inside the workspace", async () => {
    const form = await makeForm();
    const pub = new Client(ctx.app);
    await pub.post(`/api/public/forms/${form.slug}`, { answers: { name: "=HYPERLINK(\"x\")", email: "a@b.io", rush: "No", tools: ["Mail"] }, elapsedMs: 5000 });
    const res = await ctx.app.request(`/api/forms/${form.id}/responses.csv`, { headers: { cookie: c.cookie, host: "localhost" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("Quote-request-responses.csv");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("Submitted at,Your name,Email,Is it urgent?,Why is it urgent?,Seats,Tools you use");
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("-1")).toBe("'-1");
    const other = new Client(ctx.app);
    await other.signup("someone@else.io");
    expect((await other.get(`/api/forms/${form.id}/summary`)).status).toBe(404);
    expect((await other.get(`/api/forms/${form.id}/responses`)).status).toBe(404);
  });

  it("v1 and MCP: summary, responses, form_logic_set and form_results", async () => {
    const form = await makeForm();
    const pub = new Client(ctx.app);
    await pub.post(`/api/public/forms/${form.slug}`, { answers: { name: "Grace", email: "g@x.io", rush: "No", seats: "4", tools: ["Docs"] }, elapsedMs: 5000 });
    expect((await v1("GET", `/forms/${form.id}/summary`)).body.total).toBe(1);
    expect((await v1("GET", `/forms/${form.id}/responses?limit=5`)).body.responses[0].answers.name).toBe("Grace");

    const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
    const mcp = new McpClient({ name: "test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["form_logic_set", "form_results"]));
    const set = await mcp.callTool({ name: "form_logic_set", arguments: { formId: form.id, fieldId: "seats", logic: { join: "all", conditions: [{ field: "rush", op: "is", value: "Yes" }] }, rules: { max: 20 } } });
    const setBody = JSON.parse((set.content as { text: string }[])[0].text);
    expect(setBody.field).toMatchObject({ id: "seats", rules: { max: 20 }, logic: { join: "all" } });
    const bad = await mcp.callTool({ name: "form_logic_set", arguments: { formId: form.id, fieldId: "name", logic: { conditions: [{ field: "email", op: "answered" }] } } });
    expect(bad.isError).toBe(true);
    const r = await mcp.callTool({ name: "form_results", arguments: { formId: form.id, limit: 5 } });
    const body = JSON.parse((r.content as { text: string }[])[0].text);
    expect(body.total).toBe(1);
    expect(body.responses[0].answers.tools).toBe("Docs");
    expect(body.questions.find((q: { id: string }) => q.id === "seats")).toMatchObject({ kind: "number", average: 4 });
    await mcp.close();
  });
});
