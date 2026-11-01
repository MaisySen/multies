import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { unzipSync, strFromU8 } from "fflate";
import { makeTestApp, Client } from "./helpers";
import { createApp } from "@/server/app";
import {
  CASE_NO_RE, addMonths, caseFlags, formatCaseNo, formatPassphrase, lockMsFor, maskEmail, normaliseCaseNo, normalisePassphrase, reportDeadlines, DAY_MS, REPORT_LIMITS,
} from "@/shared/reporting-r112";
import { randomCode } from "@/server/services/suite/reporting-r112";
import { buildZip, findMatches } from "@/server/services/suite/data-requests-r112";

/** R112 Anonymous reporting channel and data requests: privacy, passphrase, lock, deadlines, permissions, matching, ZIP, deletion and log. Made up people only. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let orgId: string;
let pid: string;
const IP = "203.0.113.77";
const UA = "Mozilla/5.0 (R112 test browser) UniqueAgent/9.9";

async function setup(env: Record<string, string> = {}, name = "Acme") {
  ctx = await makeTestApp({ REPORTING_R112: "on", ...env });
  ctx.deps.now = () => new Date("2026-11-02T01:00:00Z");
  owner = new Client(ctx.app);
  await owner.signup("owner@acme.io", "Olive Owner");
  orgId = (await owner.get("/api/account/me")).body.organization.id;
  if (name !== "Acme") await ctx.db.run(sql`update organizations set name = ${name} where id = ${orgId}`);
}
async function teammate(email: string, role: "member" | "admin" = "member") {
  const invite = await owner.post("/api/team/invites", { email, role });
  const m = new Client(ctx.app);
  await m.signup(email, email.split("@")[0], "");
  expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  return { client: m, id: (await m.get("/api/account/me")).body.user.id as string };
}
async function turnOn() {
  const r = await owner.put("/api/reporting/channel", { enabled: true });
  expect(r.status).toBe(200);
  pid = r.body.channel.publicId;
  return r.body.channel;
}
/** A public call the way a browser would make it: with an address, a user agent and even a session cookie it should ignore. */
async function pub(method: string, path: string, body?: unknown, cookie = "") {
  const res = await ctx.app.request(path, {
    method, headers: { host: "localhost", "content-type": "application/json", "cf-connecting-ip": IP, "x-forwarded-for": IP, "user-agent": UA, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper reads any JSON body
  let json: any = null; try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: res.status, body: json, headers: res.headers };
}
async function report(what = "My manager asked me to change the safety records before the audit.") {
  const r = await pub("POST", `/api/pub/report/${pid}/cases`, { what, when: "Last Tuesday", where: "Warehouse office" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { caseNo: string; passphrase: string };
}
async function dumpAll(): Promise<string> {
  const tables = ["report_cases", "report_messages", "report_files", "report_channels", "report_day", "data_requests", "data_request_log", "audit_logs"];
  const out: unknown[] = [];
  for (const t of tables) out.push(await ctx.db.all(sql.raw(`select * from ${t}`)));
  return JSON.stringify(out);
}

describe("R112 shared rules", () => {
  it("makes case numbers and passphrases in the expected shape and reads what people type", () => {
    const no = formatCaseNo(randomCode(8));
    expect(no).toMatch(CASE_NO_RE);
    expect(normaliseCaseNo(no.toLowerCase().replace(/-/g, " "))).toBe(no);
    expect(normaliseCaseNo("RC-1234")).toBeNull();
    const pass = formatPassphrase(randomCode(20));
    expect(pass).toMatch(/^([2-9A-HJKMNP-Z]{4}-){4}[2-9A-HJKMNP-Z]{4}$/);
    expect(normalisePassphrase(pass.toLowerCase().replace(/-/g, ""))).toBe(pass);
    expect(new Set(Array.from({ length: 50 }, () => formatPassphrase(randomCode(20)))).size).toBe(50);
  });
  it("works out the 7 day and 3 month deadlines, clamping month ends", () => {
    const t = Date.UTC(2026, 10, 2, 1);
    const d = reportDeadlines(t);
    expect(d.ackDueAt - t).toBe(7 * DAY_MS);
    expect(new Date(d.outcomeDueAt).toISOString()).toBe("2027-02-02T01:00:00.000Z");
    expect(new Date(addMonths(Date.UTC(2026, 10, 30), 3)).toISOString().slice(0, 10)).toBe("2027-02-28");
    expect(new Date(addMonths(Date.UTC(2027, 10, 30), 3)).toISOString().slice(0, 10)).toBe("2028-02-29");
  });
  it("shows overdue badges only while the step is not done", () => {
    const base = { status: "new" as const, ackDueAt: 100, outcomeDueAt: 1000, acknowledgedAt: null, closedAt: null };
    expect(caseFlags(base, 50)).toEqual({ ackOverdue: false, outcomeOverdue: false });
    expect(caseFlags(base, 200)).toEqual({ ackOverdue: true, outcomeOverdue: false });
    expect(caseFlags({ ...base, status: "investigating", acknowledgedAt: 90 }, 2000)).toEqual({ ackOverdue: false, outcomeOverdue: true });
    expect(caseFlags({ ...base, status: "closed", acknowledgedAt: 90, closedAt: 900 }, 2000)).toEqual({ ackOverdue: false, outcomeOverdue: false });
  });
  it("locks after 5 wrong tries, doubling to a day", () => {
    expect(lockMsFor(4)).toBe(0);
    expect(lockMsFor(5)).toBe(REPORT_LIMITS.lockMs);
    expect(lockMsFor(10)).toBe(REPORT_LIMITS.lockMs * 2);
    expect(lockMsFor(500)).toBe(REPORT_LIMITS.maxLockMs);
    expect(maskEmail("jane.citizen@example.com")).toBe("j***@example.com");
  });
});

describe("R112 flag and channel", () => {
  it("is off without the flag", async () => {
    await setup({ REPORTING_R112: "off" });
    expect((await owner.get("/api/reporting/access")).status).toBe(404);
    expect((await owner.get("/api/config")).body.reporting).toBe(false);
    expect((await pub("GET", "/api/pub/report/abcdefghijkl")).status).toBe(404);
  });
  it("needs a workspace session, and only owners and admins change the channel", async () => {
    await setup();
    expect((await owner.get("/api/config")).body.reporting).toBe(true);
    expect((await new Client(ctx.app).get("/api/reporting/cases")).status).toBe(401);
    const mem = await teammate("mia@acme.io");
    expect((await mem.client.put("/api/reporting/channel", { enabled: true })).status).toBe(403);
    expect((await mem.client.get("/api/reporting/channel")).status).toBe(403);
    expect((await mem.client.get("/api/reporting/access")).body).toEqual({ canSee: false, isAdmin: false, assigned: 0 });
    const ch = await turnOn();
    expect(ch.url).toContain(`/report/${pid}`);
    expect((await pub("GET", `/api/pub/report/${pid}`)).body.workspace).toBe("Acme");
    await owner.put("/api/reporting/channel", { enabled: false });
    expect((await pub("GET", `/api/pub/report/${pid}`)).status).toBe(404);
  });
  it("cannot be turned on for the client workspace (vv8k)", async () => {
    await setup({}, "VV8K Holdings");
    expect((await owner.put("/api/reporting/channel", { enabled: true })).status).toBe(403);
    expect((await owner.get("/api/reporting/access")).body.canSee).toBe(false);
    expect((await owner.get("/api/data-requests")).status).toBe(403);
  });
});

describe("R112 anonymous report privacy", () => {
  beforeEach(async () => { await setup(); await turnOn(); });
  it("keeps no IP, user agent or cookie, sets no cookie, and writes no access line", async () => {
    const lines: string[] = [];
    const log = { info: (m: string, f?: unknown) => lines.push(`${m} ${JSON.stringify(f)}`), warn: (m: string, f?: unknown) => lines.push(`${m} ${JSON.stringify(f)}`), error: (m: string, f?: unknown) => lines.push(`${m} ${JSON.stringify(f)}`), debug: () => undefined };
    const app = createApp({ ...ctx.deps, log: log as never, config: { ...ctx.deps.config, mode: "development" } as never });
    const res = await app.request(`/api/pub/report/${pid}/cases`, { method: "POST", headers: { host: "localhost", "content-type": "application/json", "cf-connecting-ip": IP, "user-agent": UA, cookie: owner.cookie }, body: JSON.stringify({ what: "Someone is taking cash from the till every Friday night." }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { caseNo, passphrase } = await res.json() as { caseNo: string; passphrase: string };
    await app.request(`/api/pub/report/${pid}/login`, { method: "POST", headers: { host: "localhost", "content-type": "application/json", "cf-connecting-ip": IP, "user-agent": UA }, body: JSON.stringify({ caseNo, passphrase: "WRONG" }) });
    const all = await dumpAll();
    expect(all).not.toContain(IP);
    expect(all).not.toContain("UniqueAgent");
    expect(all).not.toContain(passphrase);
    expect(all).not.toContain(owner.cookie.split("=")[1]?.slice(0, 12) ?? "nope");
    const cols = (await ctx.db.all<{ name: string }>(sql`pragma table_info(report_cases)`)).map((c) => c.name).join(",");
    expect(cols).not.toMatch(/ip|agent|cookie/i);
    expect(lines.filter((l) => l.includes("/api/pub/report"))).toEqual([]);
    expect(lines.join("\n")).not.toContain(IP);
    // The case is not tied to the signed in person whose cookie came along.
    const row = (await ctx.db.all<{ author: string; user_id: string | null }>(sql`select author, user_id from report_messages`))[0];
    expect(row).toEqual({ author: "reporter", user_id: null });
  });
  it("stores only a slow hash of the passphrase and shows it once", async () => {
    const { caseNo, passphrase } = await report();
    const row = (await ctx.db.all<{ pass_hash: string }>(sql`select pass_hash from report_cases where case_no = ${caseNo}`))[0];
    expect(row.pass_hash).toMatch(/^pbkdf2_sha256\$100000\$/);
    expect(row.pass_hash).not.toContain(passphrase);
    const login = await pub("POST", `/api/pub/report/${pid}/login`, { caseNo, passphrase });
    expect(login.status).toBe(200);
    expect(JSON.stringify(login.body)).not.toContain("pass_hash");
    expect(login.body.thread.messages[0].body).toContain("safety records");
    expect(login.body.thread.messages[0].body).toContain("When: Last Tuesday");
  });
  it("fails cleanly on a wrong passphrase or unknown number, then locks the case number", async () => {
    const { caseNo, passphrase } = await report();
    const unknown = await pub("POST", `/api/pub/report/${pid}/login`, { caseNo: "RC-2222-2222", passphrase });
    const wrong = await pub("POST", `/api/pub/report/${pid}/login`, { caseNo, passphrase: "AAAA-BBBB-CCCC-DDDD-EEEE" });
    expect(unknown.status).toBe(401); expect(wrong.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
    for (let i = 0; i < 4; i++) await pub("POST", `/api/pub/report/${pid}/login`, { caseNo, passphrase: "nope" });
    const locked = await pub("POST", `/api/pub/report/${pid}/login`, { caseNo, passphrase });
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toMatch(/Try again in 15 minutes/);
    ctx.deps.now = () => new Date("2026-11-02T01:16:00Z");
    expect((await pub("POST", `/api/pub/report/${pid}/login`, { caseNo, passphrase })).status).toBe(200);
  });
  it("follows up both ways, with internal notes kept from the reporter", async () => {
    const { caseNo, passphrase } = await report();
    const id = (await owner.get("/api/reporting/cases")).body.cases[0].id as string;
    expect((await owner.post(`/api/reporting/cases/${id}/messages`, { text: "Only handlers: check the CCTV.", internal: true })).status).toBe(200);
    const r = await owner.post(`/api/reporting/cases/${id}/messages`, { text: "Thanks for telling us. Can you say which records?" });
    expect(r.body.case.status).toBe("acknowledged");
    expect(r.body.case.acknowledgedAt).toBeTruthy();
    const login = await pub("POST", `/api/pub/report/${pid}/login`, { caseNo, passphrase });
    const bodies = login.body.thread.messages.map((m: { body: string }) => m.body).join("|");
    expect(bodies).toContain("Can you say which records");
    expect(bodies).not.toContain("CCTV");
    expect(login.body.thread.messages.every((m: { authorName: string | null }) => m.authorName === null)).toBe(true);
    const token = login.body.token as string;
    const rep = await pub("POST", `/api/pub/report/${pid}/reply`, { caseNo, token, text: "The forklift checks for October." });
    expect(rep.status).toBe(200);
    expect((await owner.get(`/api/reporting/cases/${id}`)).body.case.messages.map((m: { body: string }) => m.body)).toContain("The forklift checks for October.");
    expect((await pub("POST", `/api/pub/report/${pid}/thread`, { caseNo, token: "x".repeat(32) })).status).toBe(401);
    ctx.deps.now = () => new Date("2026-11-02T02:00:00Z");
    expect((await pub("POST", `/api/pub/report/${pid}/thread`, { caseNo, token })).status).toBe(401);
  });
  it("takes files on a report, and gives each side only the files it may see", async () => {
    const fd = new FormData();
    fd.set("data", JSON.stringify({ what: "Photos of the damaged safety rail attached here." }));
    fd.append("files", new File([new TextEncoder().encode("photo bytes")], "rail.jpg", { type: "image/jpeg" }));
    const res = await ctx.app.request(`/api/pub/report/${pid}/cases`, { method: "POST", headers: { host: "localhost", origin: "http://localhost", "x-multies-upload": "1" }, body: fd });
    expect(res.status, await res.clone().text()).toBe(200);
    const { caseNo, passphrase } = await res.json() as { caseNo: string; passphrase: string };
    const id = (await owner.get("/api/reporting/cases")).body.cases[0].id as string;
    const detail = (await owner.get(`/api/reporting/cases/${id}`)).body.case;
    const fileId = detail.messages[0].files[0].id as string;
    const got = await ctx.app.request(`/api/reporting/cases/${id}/files/${fileId}`, { headers: { host: "localhost", cookie: owner.cookie } });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("photo bytes");
    expect(got.headers.get("content-disposition")).toContain("attachment");
    const login = await pub("POST", `/api/pub/report/${pid}/login`, { caseNo, passphrase });
    const f = await pub("POST", `/api/pub/report/${pid}/file`, { caseNo, token: login.body.token, fileId });
    expect(f.status).toBe(200);
    const big = new FormData();
    big.set("data", JSON.stringify({ what: "Four files is one too many for a message." }));
    for (let i = 0; i < 4; i++) big.append("files", new File(["x"], `f${i}.txt`));
    expect((await ctx.app.request(`/api/pub/report/${pid}/cases`, { method: "POST", headers: { host: "localhost", origin: "http://localhost", "x-multies-upload": "1" }, body: big })).status).toBe(422);
  });
  it("traps bots without keeping anything, and caps reports per day", async () => {
    const trap = await pub("POST", `/api/pub/report/${pid}/cases`, { what: "spam spam spam spam", website: "http://spam" });
    expect(trap.status).toBe(200);
    expect(trap.body.caseNo).toMatch(CASE_NO_RE);
    expect((await ctx.db.all<{ n: number }>(sql`select count(*) as n from report_cases`))[0].n).toBe(0);
    await ctx.db.run(sql`insert into report_day (org_id, kind, day, n) values (${orgId}, 'report', '2026-11-02', ${REPORT_LIMITS.reportsPerDay})`);
    expect((await pub("POST", `/api/pub/report/${pid}/cases`, { what: "One more report for today please." })).status).toBe(429);
  });
});

describe("R112 who sees cases", () => {
  beforeEach(async () => { await setup(); await turnOn(); });
  it("lets admins see all, a member only what they handle, and other workspaces nothing", async () => {
    await report();
    const mem = await teammate("mia@acme.io");
    const adm = await teammate("ari@acme.io", "admin");
    expect((await mem.client.get("/api/reporting/cases")).body.cases).toEqual([]);
    const id = (await adm.client.get("/api/reporting/cases")).body.cases[0].id as string;
    expect((await mem.client.get(`/api/reporting/cases/${id}`)).status).toBe(404);
    expect((await mem.client.patch(`/api/reporting/cases/${id}`, { handlerId: mem.id })).status).toBe(404);
    const set = await owner.patch(`/api/reporting/cases/${id}`, { handlerId: mem.id });
    expect(set.body.case.handlerId).toBe(mem.id);
    expect((await mem.client.get("/api/reporting/access")).body.canSee).toBe(true);
    expect((await mem.client.get(`/api/reporting/cases/${id}`)).status).toBe(200);
    expect((await mem.client.patch(`/api/reporting/cases/${id}`, { handlerId: null })).status).toBe(403);
    const st = await mem.client.patch(`/api/reporting/cases/${id}`, { status: "investigating" });
    expect(st.body.case.status).toBe("investigating");
    const closed = await mem.client.patch(`/api/reporting/cases/${id}`, { status: "closed", outcome: "Records corrected; training booked." });
    expect(closed.body.case.closedAt).toBeTruthy();
    expect(closed.body.case.outcomeOverdue).toBe(false);
    const other = new Client(ctx.app);
    await other.signup("boss@other.io", "Bo Other", "Other Co");
    expect((await other.get(`/api/reporting/cases/${id}`)).status).toBe(404);
    expect((await other.get("/api/reporting/cases")).body.cases).toEqual([]);
    expect((await owner.patch(`/api/reporting/cases/${id}`, { handlerId: (await other.get("/api/account/me")).body.user.id })).status).toBe(422);
  });
  it("marks acknowledgement and outcome overdue after 7 days and 3 months", async () => {
    await report();
    ctx.deps.now = () => new Date("2026-11-10T01:00:00Z");
    let c = (await owner.get("/api/reporting/cases")).body;
    expect(c.cases[0].ackOverdue).toBe(true);
    expect(c.counts.overdue).toBe(1);
    ctx.deps.now = () => new Date("2027-02-03T01:00:00Z");
    const id = c.cases[0].id as string;
    await owner.patch(`/api/reporting/cases/${id}`, { status: "acknowledged" });
    c = (await owner.get("/api/reporting/cases")).body;
    expect(c.cases[0]).toMatchObject({ ackOverdue: false, outcomeOverdue: true });
  });
});

describe("R112 data requests", () => {
  beforeEach(async () => {
    await setup();
    const t = Date.UTC(2026, 9, 1);
    await ctx.db.run(sql`insert into contacts (id, org_id, name, email, notes, source, created_at, updated_at, version) values ('ct1', ${orgId}, 'Jane Citizen', 'jane@example.com', 'Met at the expo', 'manual', ${t}, ${t}, 1)`);
    await ctx.db.run(sql`insert into contacts (id, org_id, name, email, notes, source, created_at, updated_at, version) values ('ct2', ${orgId}, 'Janet Other', 'janet@example.com', '', 'manual', ${t}, ${t}, 1)`);
    try { await ctx.db.run(sql`insert into crm_entries (id, org_id, entity_type, entity_id, body, created_at) values ('ce1', ${orgId}, 'contact', 'ct1', 'Called her', ${t})`); } catch { /* the notes table shape is not what this test is about */ }
  });
  const linkFrom = (re: RegExp) => { const m = [...ctx.outbound.sent].reverse().find((x) => re.test(String(x.text))); return String(m?.text ?? "").match(re)?.[1] ?? ""; };
  it("shows nothing until the email is confirmed by a one time link", async () => {
    const created = await owner.post("/api/data-requests", { email: "Jane@Example.com", type: "export" });
    expect(created.status).toBe(200);
    expect(created.body.request.status).toBe("unverified");
    expect(created.body.matches).toBeNull();
    const token = linkFrom(/\/data-request\/verify\/([A-Za-z0-9_-]+)/);
    expect(token).not.toBe("");
    const v = await pub("POST", "/api/pub/data-request/verify", { token });
    expect(v.status).toBe(200);
    expect((await pub("POST", "/api/pub/data-request/verify", { token })).status).toBe(404);
    const d = (await owner.get(`/api/data-requests/${created.body.request.id}`)).body;
    expect(d.request.status).toBe("verified");
    expect(d.counts).toEqual({ contacts: 1, forms: 0, bookings: 0 });
    expect(d.matches.contacts[0].name).toBe("Jane Citizen");
  });
  it("matches form answers by the email inside them, not a near miss", async () => {
    const t = Date.UTC(2026, 9, 2);
    const f = await owner.post("/api/forms", { name: "Enquiry", target: "contact", fields: [{ label: "Email", type: "email", required: true }] });
    expect(f.status, JSON.stringify(f.body)).toBeLessThan(300);
    const formId = (f.body.form?.id ?? f.body.id) as string;
    await ctx.db.run(sql`insert into form_submissions (id, org_id, form_id, data, created_at) values ('fs1', ${orgId}, ${formId}, ${JSON.stringify({ email: "JANE@example.com", msg: "hi" })}, ${t})`);
    await ctx.db.run(sql`insert into form_submissions (id, org_id, form_id, data, created_at) values ('fs2', ${orgId}, ${formId}, ${JSON.stringify({ email: "notjane@example.com.au" })}, ${t})`);
    const m = await findMatches(ctx.db, orgId, "jane@example.com");
    expect(m.forms.map((f) => f.id)).toEqual(["fs1"]);
    expect(m.contacts.map((c) => c.id)).toEqual(["ct1"]);
  });
  it("builds a ZIP with JSON and CSV, logs the download without the data", async () => {
    const created = await owner.post("/api/data-requests", { email: "jane@example.com", type: "export" });
    await pub("POST", "/api/pub/data-request/verify", { token: linkFrom(/\/data-request\/verify\/([A-Za-z0-9_-]+)/) });
    const id = created.body.request.id as string;
    const res = await ctx.app.request(`/api/data-requests/${id}/export`, { headers: { host: "localhost", cookie: owner.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["README.txt", "bookings.csv", "contacts.csv", "data.json", "form_answers.csv"]);
    expect(JSON.parse(strFromU8(files["data.json"]!)).contacts[0].email).toBe("jane@example.com");
    expect(strFromU8(files["contacts.csv"]!)).toContain("Jane Citizen");
    const log = (await owner.get("/api/data-requests/log")).body.log;
    expect(log.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(["entered", "email_confirmed", "export_downloaded"]));
    const raw = JSON.stringify(await ctx.db.all(sql`select * from data_request_log`));
    expect(raw).not.toContain("jane@example.com");
    expect(raw).not.toContain("Jane Citizen");
    expect((await ctx.db.all<{ counts: string }>(sql`select counts from data_request_log where action = 'export_downloaded'`)).map((r) => JSON.parse(r.counts))).toEqual([{ contacts: 1, forms: 0, bookings: 0 }]);
    const sent = await owner.post(`/api/data-requests/${id}/send-link`);
    expect(sent.body.request.status).toBe("done");
    const dl = linkFrom(/\/data-request\/download\/([A-Za-z0-9_-]+)/);
    const got = await ctx.app.request("/api/pub/data-request/download", { method: "POST", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ token: dl }) });
    expect(got.status).toBe(200);
    expect(Object.keys(unzipSync(new Uint8Array(await got.arrayBuffer())))).toContain("data.json");
    expect(buildZip("W", "a@b.co", { contacts: [], forms: [], bookings: [] }, Date.UTC(2026, 10, 2)).length).toBeGreaterThan(100);
  });
  it("deletes only after a confirm step, in this workspace only, and logs the counts", async () => {
    const other = new Client(ctx.app);
    await other.signup("boss@other.io", "Bo Other", "Other Co");
    const otherOrg = (await other.get("/api/account/me")).body.organization.id as string;
    const t = Date.UTC(2026, 9, 1);
    await ctx.db.run(sql`insert into contacts (id, org_id, name, email, notes, source, created_at, updated_at, version) values ('ct9', ${otherOrg}, 'Jane Elsewhere', 'jane@example.com', '', 'manual', ${t}, ${t}, 1)`);
    const exp = await owner.post("/api/data-requests", { email: "jane@example.com", type: "export" });
    const created = await owner.post("/api/data-requests", { email: "jane@example.com", type: "delete" });
    const id = created.body.request.id as string;
    expect((await owner.post(`/api/data-requests/${id}/delete`, { confirm: "DELETE" })).status).toBe(409);
    await pub("POST", "/api/pub/data-request/verify", { token: linkFrom(/\/data-request\/verify\/([A-Za-z0-9_-]+)/) });
    expect((await owner.post(`/api/data-requests/${id}/delete`, { confirm: "yes" })).status).toBe(422);
    const mem = await teammate("mia@acme.io");
    expect((await mem.client.post(`/api/data-requests/${id}/delete`, { confirm: "DELETE" })).status).toBe(403);
    expect((await mem.client.get("/api/data-requests")).status).toBe(403);
    expect((await other.get(`/api/data-requests/${id}`)).status).toBe(404);
    expect((await owner.post(`/api/data-requests/${exp.body.request.id}/delete`, { confirm: "DELETE" })).status).toBe(409);
    const done = await owner.post(`/api/data-requests/${id}/delete`, { confirm: "DELETE" });
    expect(done.status).toBe(200);
    expect(done.body.request.status).toBe("done");
    expect(done.body.request.email).toBe("j***@example.com");
    const left = await ctx.db.all<{ id: string }>(sql`select id from contacts where lower(email) = 'jane@example.com'`);
    expect(left.map((r) => r.id)).toEqual(["ct9"]);
    expect((await ctx.db.all<{ id: string }>(sql`select id from contacts where id = 'ct2'`)).length).toBe(1);
    const last = done.body.log.at(-1);
    expect(last).toMatchObject({ action: "deleted", counts: { contacts: 1, forms: 0, bookings: 0 } });
    expect(JSON.stringify(await ctx.db.all(sql`select * from data_request_log`))).not.toContain("Jane");
  });
  it("public page: off until an admin turns it on, same answer for any address, daily cap", async () => {
    const s = await owner.put("/api/data-requests/settings", { publicEnabled: false });
    const pidD = s.body.url.split("/data-request/")[1] as string;
    expect((await pub("GET", `/api/pub/data-request/${pidD}`)).status).toBe(404);
    await owner.put("/api/data-requests/settings", { publicEnabled: true });
    expect((await pub("GET", `/api/pub/data-request/${pidD}`)).body.workspace).toBe("Acme");
    const a = await pub("POST", `/api/pub/data-request/${pidD}`, { email: "jane@example.com", type: "delete" });
    const b = await pub("POST", `/api/pub/data-request/${pidD}`, { email: "nobody@example.com", type: "delete" });
    expect(a.body).toEqual({ ok: true }); expect(b.body).toEqual({ ok: true });
    expect((await pub("POST", `/api/pub/data-request/${pidD}`, { email: "not an email", type: "export" })).status).toBe(422);
    const list = (await owner.get("/api/data-requests")).body.requests;
    expect(list).toHaveLength(2);
    expect(list[0].dueAt - list[0].createdAt).toBe(30 * DAY_MS);
    ctx.deps.now = () => new Date("2026-11-05T01:00:00Z");
    expect((await owner.get("/api/data-requests")).body.requests[0].status).toBe("expired");
  });
});
