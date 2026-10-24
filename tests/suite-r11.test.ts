import { describe, it, expect, beforeEach } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { makeTestApp, Client } from "./helpers";
import { eventText, isTeamsWorkflowsUrl, mapFields } from "@/server/services/suite/integrations";
import { busyTimes, computeSlots, zonedTime } from "@/server/services/suite/scheduling";

let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
let sent: { url: string; body: string; headers: Record<string, string> }[] = [];

async function setup(env: Record<string, string> = {}) {
  sent = [];
  const fetchMock = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? ""), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  ctx = await makeTestApp(env, { fetch: fetchMock });
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
}
async function api(key: string, method: string, path: string, body?: unknown) {
  const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
async function hookPost(token: string, body: string, contentType = "application/json", extra: Record<string, string> = {}) {
  const res = await ctx.app.request(`/api/hooks/in/${token}`, { method: "POST", headers: { "content-type": contentType, host: "localhost", ...extra }, body });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function mcpFor(key: string) {
  const fetchViaApp = ((url: string | URL, init?: RequestInit) => ctx.app.request(new URL(url).pathname, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "localhost" } })) as typeof fetch;
  const client = new McpClient({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/api/v1/mcp"), { requestInit: { headers: { authorization: `Bearer ${key}` } }, fetch: fetchViaApp }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);
const tokenOf = (url: string) => url.split("/api/hooks/in/")[1];

describe("integration helpers", () => {
  it("writes a chat line for an event and maps hook fields", () => {
    expect(eventText({ type: "task.created", data: { task: { ref: "OPS-4", title: "Ship it" }, actor: { name: "Sam" } } })).toBe("Multies: New task: OPS-4 Ship it (by Sam)");
    expect(eventText({ type: "webhook.test" })).toContain("connected");
    expect(mapFields("task", { subject: "Hello", description: "Body", deadline: "2026-11-01" })).toEqual({ title: "Hello", notes: "Body", due: "2026-11-01" });
    expect(mapFields("task", { data: { name: "Deep" } }, { title: "data.name" })).toEqual({ title: "Deep" });
    expect(mapFields("contact", { email_address: "a@b.co", first_name: "Ann", last_name: "Lee" })).toEqual({ email: "a@b.co", name: "Ann Lee" });
  });
});

describe("outgoing connectors", () => {
  beforeEach(() => setup());

  it("lists the catalogue, connects Slack with a message body, tests, pauses and deletes", async () => {
    const list = await c.get("/api/connectors");
    expect(list.status).toBe(200);
    expect(list.body.catalogue.map((x: { id: string }) => x.id)).toEqual(["slack", "discord", "teams", "zapier", "make", "n8n", "sheets", "custom"]);
    const r = await c.post("/api/connectors", { connector: "slack", url: "https://hooks.slack.com/services/T0/B0/xyz", events: ["task.created"] });
    expect(r.status).toBe(201);
    expect(r.body.connection.format).toBe("slack");
    expect(r.body.secret).toBeUndefined();
    const id = r.body.connection.id;
    const t = await c.post(`/api/connectors/${id}/test`);
    expect(t.body.delivery.status).toBe("delivered");
    expect(JSON.parse(sent[0].body)).toEqual({ text: expect.stringContaining("connected") });
    await c.post("/api/tasks", { title: "Call Jo" });
    const last = JSON.parse(sent[sent.length - 1].body);
    expect(last.text).toContain("New task");
    expect(last.text).toContain("Call Jo");
    expect((await c.patch(`/api/connectors/${id}`, { enabled: false })).body.connection.enabled).toBe(false);
    expect((await c.del(`/api/connectors/${id}`)).status).toBe(200);
    expect((await c.get("/api/connectors")).body.connections).toEqual([]);
  });

  it("sends Discord content, and our signed JSON to Zapier with a secret", async () => {
    await c.post("/api/connectors", { connector: "discord", url: "https://discord.com/api/webhooks/1/abc", events: ["task.created"] });
    const z = await c.post("/api/connectors", { connector: "zapier", url: "https://hooks.zapier.com/hooks/catch/1/abc/", events: ["task.created"] });
    expect(z.body.secret).toMatch(/^whsec_/);
    await c.post("/api/tasks", { title: "Quote for Kim" });
    const discord = sent.find((s) => s.url.includes("discord.com"))!;
    expect(JSON.parse(discord.body).content).toContain("Quote for Kim");
    const zap = sent.find((s) => s.url.includes("zapier.com"))!;
    expect(JSON.parse(zap.body).type).toBe("task.created");
    expect(zap.headers["webhook-signature"]).toMatch(/^v1,/);
  });

  it("refuses an unknown connector, a private address and members", async () => {
    expect((await c.post("/api/connectors", { connector: "nope", url: "https://example.com/x" })).status).toBe(422);
    const invite = await c.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const m = new Client(ctx.app);
    await m.signup("mate@acme.io", "Sam Mate", "");
    await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`);
    expect((await m.post("/api/connectors", { connector: "slack", url: "https://hooks.slack.com/services/a" })).status).toBe(403);
    expect((await m.get("/api/connectors")).status).toBe(200);
  });
});

describe("Teams Workflows", () => {
  beforeEach(() => setup());

  it("tells Workflows URLs from classic connector URLs", () => {
    expect(isTeamsWorkflowsUrl("https://prod-12.australiasoutheast.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x")).toBe(true);
    expect(isTeamsWorkflowsUrl("https://default123.ab.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke")).toBe(true);
    expect(isTeamsWorkflowsUrl("https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def")).toBe(false);
    expect(isTeamsWorkflowsUrl("not a url")).toBe(false);
  });

  it("sends an Adaptive Card to a Workflows URL and plain text to a classic connector", async () => {
    const wf = await c.post("/api/connectors", { connector: "teams", url: "https://prod-12.australiasoutheast.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x", events: ["task.created"] });
    expect(wf.status).toBe(201);
    await c.post(`/api/connectors/${wf.body.connection.id}/test`);
    const card = JSON.parse(sent[sent.length - 1].body);
    expect(card.type).toBe("message");
    expect(card.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.attachments[0].content).toMatchObject({ type: "AdaptiveCard", version: "1.4" });
    await c.post("/api/tasks", { title: "Call Jo" });
    const task = JSON.parse(sent[sent.length - 1].body).attachments[0].content;
    expect(task.body[0].text).toBe("New task");
    expect(task.body[1].text).toContain("Call Jo");

    const classic = await c.post("/api/connectors", { connector: "teams", url: "https://acme.webhook.office.com/webhookb2/abc/IncomingWebhook/def", events: ["task.created"] });
    await c.post(`/api/connectors/${classic.body.connection.id}/test`);
    expect(JSON.parse(sent[sent.length - 1].body)).toEqual({ text: expect.stringContaining("connected") });
  });
});

describe("incoming webhooks", () => {
  beforeEach(() => setup());

  it("turns JSON and form posts into tasks, records calls, and revokes", async () => {
    const r = await c.post("/api/incoming-hooks", { name: "Website", action: "task" });
    expect(r.status).toBe(201);
    const token = tokenOf(r.body.url);
    expect(token).toMatch(/^mih_/);
    expect(JSON.stringify((await c.get("/api/incoming-hooks")).body)).not.toContain(token);

    const ok = await hookPost(token, JSON.stringify({ subject: "Quote request", message: "Two rooms", due: "2026-11-02", assignee: "owner@acme.io", budget: 900 }));
    expect(ok.status).toBe(201);
    expect(ok.body.result.type).toBe("task");
    const task = (await c.get(`/api/tasks/${ok.body.result.id}`)).body.task;
    expect(task.title).toBe("Quote request");
    expect(task.notes ?? task.description).toContain("Two rooms");
    expect(task.assignee?.id).toBeTruthy();

    const form = await hookPost(token, "title=From+a+form&extra=1", "application/x-www-form-urlencoded");
    expect(form.status).toBe(201);
    const bad = await hookPost(token, JSON.stringify({ nothing: "here" }));
    expect(bad.status).toBe(422);
    expect((await hookPost(token, "x".repeat(70_000), "text/plain")).status).toBe(413);

    const hook = (await c.get(`/api/incoming-hooks/${r.body.hook.id}`)).body.hook;
    expect(hook.callCount).toBe(3);
    expect(hook.recent.map((x: { status: number }) => x.status)).toEqual([422, 201, 201]);

    expect((await hookPost("mih_doesnotexist0000000000", "{}")).status).toBe(404);
    await c.patch(`/api/incoming-hooks/${r.body.hook.id}`, { enabled: false });
    expect((await hookPost(token, JSON.stringify({ title: "x" }))).status).toBe(404);
    await c.del(`/api/incoming-hooks/${r.body.hook.id}`);
    expect((await c.get("/api/incoming-hooks")).body.hooks).toEqual([]);
  });

  it("posts chat messages and creates contacts, and emits incoming_hook.received", async () => {
    const general = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    expect((await c.post("/api/incoming-hooks", { name: "No channel", action: "chat" })).status).toBe(422);
    await c.post("/api/connectors", { connector: "custom", url: "https://receiver.example.com/in", events: ["incoming_hook.received"] });
    const chat = await c.post("/api/incoming-hooks", { name: "Deploys", action: "chat", config: { channelId: general.id } });
    const res = await hookPost(tokenOf(chat.body.url), JSON.stringify({ text: "Deploy finished" }));
    expect(res.status).toBe(201);
    const msgs = (await c.get(`/api/chat/channels/${general.id}/messages`)).body.messages as { body: string }[];
    expect(msgs.some((m) => m.body === "Deploy finished")).toBe(true);
    expect(sent.some((s) => JSON.parse(s.body).type === "incoming_hook.received")).toBe(true);

    const contact = await c.post("/api/incoming-hooks", { name: "Leads", action: "contact" });
    const lead = await hookPost(tokenOf(contact.body.url), JSON.stringify({ email: "Lead@Example.com", first_name: "Lea", last_name: "Ng" }));
    expect(lead.status).toBe(201);
    expect(lead.body.result.type).toBe("contact");
  });

  it("works over REST and MCP with an API key", async () => {
    const key = (await c.post("/api/developer/keys", { name: "Zap" })).body.secret;
    expect((await api("mm_bad", "GET", "/integrations/catalogue")).status).toBe(401);
    const cat = await api(key, "GET", "/integrations/catalogue");
    expect(cat.status).toBe(200);
    expect(cat.body.catalogue).toHaveLength(8);
    const made = await api(key, "POST", "/incoming-hooks", { name: "Script", action: "task" });
    expect(made.status).toBe(201);
    expect((await api(key, "GET", "/incoming-hooks")).body.hooks).toHaveLength(1);
    expect((await api(key, "PATCH", `/incoming-hooks/${made.body.hook.id}`, { name: "Renamed" })).body.hook.name).toBe("Renamed");
    expect((await api(key, "POST", "/integrations", { connector: "n8n", url: "https://n8n.example.com/webhook/1" })).status).toBe(201);
    expect((await api(key, "DELETE", `/incoming-hooks/${made.body.hook.id}`)).status).toBe(200);

    const mcp = await mcpFor(key);
    const created = data(await mcp.callTool({ name: "create_incoming_hook", arguments: { name: "From MCP", action: "task" } }));
    expect(created.url).toContain("/api/hooks/in/mih_");
    const listed = data(await mcp.callTool({ name: "list_integrations", arguments: {} }));
    expect(listed.connections).toHaveLength(1);
    expect(listed.incomingHooks).toHaveLength(1);
    await mcp.close();
  });
});

describe("scheduling slots", () => {
  it("converts wall clock times in a zone and leaves out busy times, buffers and notice", () => {
    expect(zonedTime(2026, 10, 26, 9 * 60, "Australia/Sydney").toISOString()).toBe("2026-10-25T22:00:00.000Z");
    expect(zonedTime(2026, 11, 2, 9 * 60, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
    const rules = { timezone: "Australia/Sydney", hours: { mon: [["09:00", "11:00"]] as [string, string][] }, slotMin: 30, bufferMin: 0, maxDaysAhead: 30, minNoticeMin: 0 };
    const now = new Date("2026-10-24T00:00:00Z");
    const to = new Date("2026-10-27T00:00:00Z");
    const busy = [{ start: Date.parse("2026-10-25T22:30:00Z"), end: Date.parse("2026-10-25T23:00:00Z") }];
    expect(computeSlots(rules, busy, now, now, to)).toEqual(["2026-10-25T22:00:00.000Z", "2026-10-25T23:00:00.000Z", "2026-10-25T23:30:00.000Z"]);
    expect(computeSlots({ ...rules, bufferMin: 15 }, busy, now, now, to)).toEqual(["2026-10-25T23:30:00.000Z"]);
    expect(computeSlots({ ...rules, maxDaysAhead: 1 }, [], now, now, to)).toEqual([]);
    expect(computeSlots(rules, [], new Date("2026-10-25T22:40:00Z"), new Date("2026-10-25T22:40:00Z"), to)).toEqual(["2026-10-25T23:00:00.000Z", "2026-10-25T23:30:00.000Z"]);
  });
});

describe("busy times", () => {
  it("expands a weekly series on read inside the window and keeps one-off meetings and bookings", () => {
    const from = new Date("2026-10-24T00:00:00Z"), to = new Date("2026-11-08T00:00:00Z");
    const busy = busyTimes(
      [{ startsAt: new Date("2026-10-05T22:00:00Z"), durationMin: 60, recurrence: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", recurrenceTz: "Australia/Sydney" },
        { startsAt: new Date("2026-10-27T01:00:00Z"), durationMin: 30 }],
      [{ startsAt: new Date("2026-10-28T03:00:00Z"), durationMin: 15 }], from, to);
    expect(busy.map((b) => new Date(b.start).toISOString())).toEqual(["2026-10-25T22:00:00.000Z", "2026-11-01T22:00:00.000Z", "2026-10-27T01:00:00.000Z", "2026-10-28T03:00:00.000Z"]);
    expect(busyTimes([{ startsAt: new Date("2026-10-05T22:00:00Z"), durationMin: 60, recurrence: "FREQ=WEEKLY;COUNT=2;BYDAY=MO", recurrenceTz: "Australia/Sydney" }], [], from, to)).toEqual([]);
    expect(busyTimes([{ startsAt: new Date("2026-10-05T22:00:00Z"), durationMin: 60, recurrence: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", recurrenceTz: "Australia/Sydney" }], [], from, to)).toHaveLength(1);
  });
});

describe("scheduling", () => {
  beforeEach(async () => {
    await setup({ SCHEDULING_ENABLED: "true" });
    ctx.deps.now = () => new Date("2026-10-24T00:00:00Z");
    const r = await c.put("/api/scheduling/page", { slug: "olive", title: "Intro call", timezone: "Australia/Sydney", hours: { mon: [["09:00", "11:00"]] }, slotMin: 30, minNoticeMin: 0 });
    expect(r.status).toBe(200);
  });
  const guest = () => new Client(ctx.app);
  const book = (startsAt: string, email = "kim@example.com") => guest().post("/api/book/olive", { startsAt, name: "Kim Lee", email, note: "About the quote" });

  it("shows free slots, books one, blocks a double booking, and sends the event and the .ics", async () => {
    await c.post("/api/connectors", { connector: "custom", url: "https://receiver.example.com/in", events: ["booking.created", "booking.cancelled"] });
    const pub = await guest().get("/api/book/olive");
    expect(pub.status).toBe(200);
    expect(pub.body.page).toMatchObject({ title: "Intro call", host: "Olive Owner", slotMin: 30 });
    expect(pub.body.slots).toEqual(["2026-10-25T22:00:00.000Z", "2026-10-25T22:30:00.000Z", "2026-10-25T23:00:00.000Z", "2026-10-25T23:30:00.000Z", "2026-11-01T22:00:00.000Z", "2026-11-01T22:30:00.000Z", "2026-11-01T23:00:00.000Z", "2026-11-01T23:30:00.000Z"]);

    const r = await book("2026-10-25T22:30:00.000Z");
    expect(r.status).toBe(201);
    expect(r.body.booking).toMatchObject({ name: "Kim Lee", status: "confirmed", durationMin: 30 });
    expect(r.body.booking.guestUrl).toContain("/m/");
    expect((await book("2026-10-25T22:30:00.000Z", "other@example.com")).status).toBe(409);
    expect((await book("2026-10-25T22:10:00.000Z")).status).toBe(409);
    expect((await guest().get("/api/book/olive")).body.slots).not.toContain("2026-10-25T22:30:00.000Z");
    expect(sent.some((s) => JSON.parse(s.body).type === "booking.created")).toBe(true);

    const meetings = (await c.get("/api/meetings")).body.meetings as { title: string }[];
    expect(meetings.some((m) => m.title === "Intro call: Kim Lee")).toBe(true);
    const token = new URL(r.body.cancelUrl).searchParams.get("t")!;
    const ics = await ctx.app.request(`/api/book/bookings/${r.body.booking.id}/ics?t=${token}`, { headers: { host: "localhost" } });
    expect(ics.headers.get("content-type")).toContain("text/calendar");
    expect(await ics.text()).toContain("BEGIN:VEVENT");
    expect((await ctx.app.request(`/api/book/bookings/${r.body.booking.id}/ics?t=wrong`, { headers: { host: "localhost" } })).status).toBe(404);
  });

  it("counts every occurrence of the host's weekly series as busy, not just the first", async () => {
    // A weekly Monday 09:00 Sydney meeting that started the week before the window.
    const made = await c.post("/api/meetings", { title: "Weekly product review", startsAt: "2026-10-18T22:00:00.000Z", durationMin: 30, recurrence: { days: ["mo"], timezone: "Australia/Sydney" } });
    expect(made.status).toBe(201);
    const slots = (await guest().get("/api/book/olive")).body.slots as string[];
    expect(slots).not.toContain("2026-10-25T22:00:00.000Z");
    expect(slots).not.toContain("2026-11-01T22:00:00.000Z");
    expect(slots).toContain("2026-10-25T22:30:00.000Z");
    expect((await book("2026-11-01T22:00:00.000Z")).status).toBe(409);
  });

  it("lets the guest cancel with the link and the host cancel from the app, and frees the slot", async () => {
    const r = await book("2026-10-25T22:00:00.000Z");
    const token = new URL(r.body.cancelUrl).searchParams.get("t")!;
    expect((await guest().get(`/api/book/bookings/${r.body.booking.id}?t=${token}`)).body.booking.status).toBe("confirmed");
    expect((await guest().post(`/api/book/bookings/${r.body.booking.id}/cancel`, { token: "nope" })).status).toBe(404);
    const g = await guest().post(`/api/book/bookings/${r.body.booking.id}/cancel`, { token });
    expect(g.body.booking).toMatchObject({ status: "cancelled", cancelledBy: "guest" });
    expect((await guest().get("/api/book/olive")).body.slots).toContain("2026-10-25T22:00:00.000Z");

    const again = await book("2026-10-25T22:00:00.000Z", "second@example.com");
    expect(again.status).toBe(201);
    const list = (await c.get("/api/scheduling/bookings")).body.bookings as { id: string; status: string }[];
    expect(list.map((b) => b.status)).toEqual(["cancelled", "confirmed"]);
    const h = await c.post(`/api/scheduling/bookings/${again.body.booking.id}/cancel`);
    expect(h.body.booking).toMatchObject({ status: "cancelled", cancelledBy: "host" });
  });

  it("validates the page and the booking, and serves REST and MCP", async () => {
    expect((await c.put("/api/scheduling/page", { slotMin: 20 })).status).toBe(422);
    expect((await c.put("/api/scheduling/page", { timezone: "Mars/Base" })).status).toBe(422);
    expect((await c.put("/api/scheduling/page", { hours: { mon: [["11:00", "09:00"]] } })).status).toBe(422);
    expect((await guest().post("/api/book/olive", { startsAt: "2026-10-25T22:00:00.000Z", name: "", email: "x@y.co" })).status).toBe(422);
    expect((await guest().post("/api/book/olive", { startsAt: "2026-10-25T22:00:00.000Z", name: "A", email: "bad" })).status).toBe(422);
    expect((await guest().get("/api/book/nobody")).status).toBe(404);
    await c.put("/api/scheduling/page", { enabled: false });
    expect((await guest().get("/api/book/olive")).status).toBe(404);
    await c.put("/api/scheduling/page", { enabled: true });
    await book("2026-11-01T22:00:00.000Z");

    const key = (await c.post("/api/developer/keys", { name: "Cal" })).body.secret;
    expect((await api(key, "GET", "/scheduling/availability")).body.page.slug).toBe("olive");
    const listed = await api(key, "GET", "/scheduling/bookings");
    expect(listed.body.bookings).toHaveLength(1);
    const mcp = await mcpFor(key);
    const mb = data(await mcp.callTool({ name: "list_bookings", arguments: { upcoming: true } }));
    expect(mb.bookings[0].name).toBe("Kim Lee");
    await mcp.close();
  });

  it("answers 404 everywhere when scheduling is off", async () => {
    await setup();
    expect((await c.get("/api/scheduling/page")).status).toBe(404);
    expect((await c.get("/api/book/olive")).status).toBe(404);
    expect((await c.get("/api/config")).body.scheduling).toBe(false);
    const key = (await c.post("/api/developer/keys", { name: "Cal" })).body.secret;
    expect((await api(key, "GET", "/scheduling/bookings")).status).toBe(404);
  });
});
