/**
 * TD7 Forms pro B: close date and cap enforced on the server (cap race), password hash, rate limit and access token,
 * resume token sign, expiry and tamper, counting without cookies, import parsing, AI off or no key = no provider call,
 * owner only settings and other workspace 404, flag off = today, and no answers or passwords in logs.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { cleanDraft, closedReason, csvCells, dropOff, parseImport, parseTd7 } from "@/shared/forms-td7";
import { accessOk, accessToken, readResume, resumeToken } from "@/server/services/forms-td7/pro";

async function setup(env: Record<string, string> = { FORMS_TD7: "on", APP_URL: "http://localhost" }) {
  const ctx = await makeTestApp(env);
  let clock = Date.parse("2026-11-02T00:00:00Z");
  ctx.deps.now = () => new Date(clock);
  const logs: string[] = [];
  const owner = new Client(ctx.app);
  await owner.signup("ada@acme.io", "Ada Lovelace", "Acme");
  return { ...ctx, owner, logs, advance: (ms: number) => { clock += ms; } };
}
type T = Awaited<ReturnType<typeof setup>>;
async function pub(t: T, method: string, path: string, body?: unknown, ip = "10.2.2.2") {
  const res = await t.app.request(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { host: "localhost", "content-type": "application/json", "cf-connecting-ip": ip } });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const FIELDS = [{ id: "name", label: "Your name", type: "text", required: true }, { id: "email", label: "Email", type: "email", required: true }, { id: "msg", label: "Message", type: "textarea" }];
async function makeForm(t: T) {
  const r = await t.owner.post("/api/forms", { name: "Intake", target: "contact", fields: FIELDS });
  expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBeLessThan(300);
  const form = r.body.form ?? r.body;
  return { id: form.id as string, slug: String(form.url).split("/f/")[1] as string };
}
const send = (t: T, slug: string, answers: Record<string, unknown>, extra: Record<string, unknown> = {}, ip = "10.2.2.2") => pub(t, "POST", `/api/public/forms/${slug}`, { answers, elapsedMs: 5000, ...extra }, ip);
const A = (n: number) => ({ name: `Person ${n}`, email: `p${n}@example.com`, msg: "Hello" });

describe("TD7 shared rules", () => {
  it("keeps only known settings and enums", () => {
    const s = parseTd7({ brand: { accent: "red; background:url(x)", font: "mono", logo: "wide" }, responseCap: "12.7", closesAt: "2026-12-01T10:00:00Z", saveResume: true, closedMessage: " Done " });
    expect(s.brand).toEqual({ accent: "default", surface: "plain", font: "mono", logo: "wide" });
    expect(s.responseCap).toBe(12);
    expect(s.closesAt).toBe("2026-12-01T10:00:00.000Z");
    expect(s.closedMessage).toBe("Done");
    expect(parseTd7("not json")).toEqual(parseTd7({}));
    expect(parseTd7({ responseCap: 0 }).responseCap).toBeNull();
  });
  it("closes by date or cap", () => {
    const s = parseTd7({ closesAt: "2026-11-02T10:00:00Z", responseCap: 2 });
    expect(closedReason(s, new Date("2026-11-02T09:59:59Z"), 1)).toBeNull();
    expect(closedReason(s, new Date("2026-11-02T10:00:00Z"), 0)).toBe("date");
    expect(closedReason(s, new Date("2026-11-01T00:00:00Z"), 2)).toBe("cap");
  });
  it("imports pasted questions and CSV", () => {
    const p = parseImport("1. Your name *\n- Email address\nSize: Small | Medium | Large\nAnything else you want to tell us?\n\n");
    expect(p.fields.map((f) => [f.label, f.type, f.required])).toEqual([["Your name", "text", true], ["Email address", "email", false], ["Size", "select", false], ["Anything else you want to tell us?", "textarea", false]]);
    expect(p.fields[2].options).toEqual(["Small", "Medium", "Large"]);
    const c = parseImport('label,type,required,options\n"Name, full",text,yes,\nPick one,choice,no,A|B\nWhen,date,1,\n,text,,');
    expect(c.fields.map((f) => [f.label, f.type, f.required])).toEqual([["Name, full", "text", true], ["Pick one", "select", false], ["When", "date", true]]);
    expect(c.skipped).toBe(1);
    expect(csvCells('a,"b ""c""",d')).toEqual(["a", 'b "c"', "d"]);
    expect(parseImport(Array.from({ length: 80 }, (_, i) => `Q${i}`).join("\n")).fields).toHaveLength(30);
    expect(new Set(parseImport("Name\nName\nName").fields.map((f) => f.id)).size).toBe(3);
  });
  it("cleans an AI draft into known types only", () => {
    const d = cleanDraft('Sure! {"name":"Event signup","fields":[{"label":"Email","type":"email","required":true},{"label":"Meal","type":"select","options":["Veg"]},{"label":"<b>x</b>","type":"script"},{"type":"text"}]}');
    expect(d?.name).toBe("Event signup");
    expect(d?.fields.map((f) => f.type)).toEqual(["email", "text", "text"]);
    expect(cleanDraft("no json")).toBeNull();
  });
  it("counts drop off per question, never negative", () => {
    const r = dropOff([{ id: "a", label: "A" }, { id: "b", label: "B" }], { a: 10, b: 6 }, 4);
    expect(r.map((x) => x.dropped)).toEqual([4, 2]);
    expect(dropOff([{ id: "a", label: "A" }], { a: 1 }, 3)[0].dropped).toBe(0);
  });
});

describe("TD7 tokens", () => {
  it("signs, expires and refuses tampering", async () => {
    const t = await setup();
    const tok = await resumeToken(t.deps, "frm_1", "fpt_abcdefghijkl", t.deps.now().getTime() + 60_000);
    expect(await readResume(t.deps, "frm_1", tok)).toBe("fpt_abcdefghijkl");
    expect(await readResume(t.deps, "frm_2", tok)).toBeNull();
    const [id, exp, sig] = tok.split(".");
    expect(await readResume(t.deps, "frm_1", `${id}.${Number(exp) + 1}.${sig}`)).toBeNull();
    expect(await readResume(t.deps, "frm_1", `fpt_zzzzzzzzzzzz.${exp}.${sig}`)).toBeNull();
    t.advance(61_000);
    expect(await readResume(t.deps, "frm_1", tok)).toBeNull();
    const a = await accessToken(t.deps, "frm_1", "pbkdf2_sha256$1$aaaa$bbbbbbbbbbbbbbbbbbbb");
    expect(await accessOk(t.deps, "frm_1", "pbkdf2_sha256$1$aaaa$bbbbbbbbbbbbbbbbbbbb", a)).toBe(true);
    expect(await accessOk(t.deps, "frm_1", "pbkdf2_sha256$1$aaaa$cccccccccccccccccccc", a)).toBe(false); // new password ends old access
    expect(await accessOk(t.deps, "frm_1", null, undefined)).toBe(true);
  });
});

describe("TD7 server enforcement", () => {
  it("flag off: no TD7 paths, the public form is as today", async () => {
    const t = await setup({ APP_URL: "http://localhost" });
    const f = await makeForm(t);
    expect((await t.owner.get(`/api/forms/${f.id}/pro`)).status).toBe(404);
    expect((await t.owner.get("/api/config")).body.formsTd7).toBe(false);
    const g = await pub(t, "GET", `/api/public/forms/${f.slug}`);
    expect(g.body.form.td7).toBeUndefined();
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/events`, { kind: "view" })).status).toBe(404);
    expect((await send(t, f.slug, A(1))).status).toBe(200);
  });

  it("close date and response cap hold on the server, with a closed page", async () => {
    const t = await setup();
    const f = await makeForm(t);
    expect((await t.owner.put(`/api/forms/${f.id}/pro`, { settings: { responseCap: 2, closedMessage: "All full, thanks." } })).status).toBe(200);
    expect((await send(t, f.slug, A(1))).status).toBe(200);
    // two at once for the last place: exactly one gets it
    const [x, y] = await Promise.all([send(t, f.slug, A(2), {}, "10.3.3.3"), send(t, f.slug, A(3), {}, "10.4.4.4")]);
    expect([x.status, y.status].sort()).toEqual([200, 410]);
    const g = await pub(t, "GET", `/api/public/forms/${f.slug}`);
    expect(g.body.form.td7.closed).toBe("cap");
    expect(g.body.form.td7.closedMessage).toBe("All full, thanks.");
    expect(g.body.form.fields).toEqual([]);
    expect((await t.owner.get(`/api/forms/${f.id}`)).body.form?.submitCount ?? (await t.owner.get(`/api/forms/${f.id}`)).body.submitCount).toBe(2);
    await t.owner.put(`/api/forms/${f.id}/pro`, { settings: { responseCap: null, closesAt: "2026-11-02T01:00:00Z" } });
    expect((await send(t, f.slug, A(4))).status).toBe(200);
    t.advance(2 * 60 * 60_000);
    const late = await send(t, f.slug, A(5));
    expect(late.status).toBe(410);
    expect(late.body.error.code).toBe("form_closed");
  });

  it("a failed save gives the cap place back", async () => {
    const t = await setup();
    const f = await makeForm(t);
    await t.owner.put(`/api/forms/${f.id}/pro`, { settings: { responseCap: 1 } });
    const bad = await send(t, f.slug, { name: "No email" });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    expect((await send(t, f.slug, A(1))).status).toBe(200);
  });

  it("password: hashed, never shown, rate limited, access required to answer", async () => {
    const t = await setup();
    const f = await makeForm(t);
    const spy = vi.spyOn(console, "log"); const spyW = vi.spyOn(console, "warn"); const spyE = vi.spyOn(console, "error");
    expect((await t.owner.put(`/api/forms/${f.id}/pro`, { password: "abc" })).status).toBe(422);
    const set = await t.owner.put(`/api/forms/${f.id}/pro`, { password: "Secret word 77" });
    expect(set.body.hasPassword).toBe(true);
    expect(JSON.stringify(set.body)).not.toMatch(/Secret word|pbkdf2/);
    expect(JSON.stringify((await t.owner.get(`/api/forms/${f.id}/pro`)).body)).not.toMatch(/pbkdf2/);
    const g = await pub(t, "GET", `/api/public/forms/${f.slug}`);
    expect(g.body.form.td7.locked).toBe(true);
    expect(g.body.form.fields).toEqual([]);
    expect((await send(t, f.slug, A(1))).status).toBe(401);
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/password`, { password: "wrong" })).status).toBe(401);
    const ok = await pub(t, "POST", `/api/public/forms/${f.slug}/password`, { password: "Secret word 77" });
    expect(ok.status).toBe(200);
    expect(ok.body.form.fields).toHaveLength(3);
    expect((await send(t, f.slug, A(1), { td7Access: ok.body.access })).status).toBe(200);
    expect((await send(t, f.slug, A(2), { td7Access: ok.body.access + "x" })).status).toBe(401);
    for (let i = 0; i < 10; i++) await pub(t, "POST", `/api/public/forms/${f.slug}/password`, { password: `nope${i}` }, "10.9.9.9");
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/password`, { password: "Secret word 77" }, "10.9.9.9")).status).toBe(429);
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/password`, { password: "Secret word 77" }, "10.8.8.8")).status).toBe(200);
    const all = [...spy.mock.calls, ...spyW.mock.calls, ...spyE.mock.calls].map((c) => JSON.stringify(c)).join("\n");
    expect(all).not.toMatch(/Secret word|nope\d|p1@example\.com|Person 1/);
    // a new password ends old access
    await t.owner.put(`/api/forms/${f.id}/pro`, { password: "Another one 88" });
    expect((await send(t, f.slug, A(3), { td7Access: ok.body.access })).status).toBe(401);
    await t.owner.put(`/api/forms/${f.id}/pro`, { password: null });
    expect((await send(t, f.slug, A(3))).status).toBe(200);
  });

  it("save and resume: signed link, expiry, owner sees parts apart, sent answer removes the part", async () => {
    const t = await setup();
    const f = await makeForm(t);
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/partial`, { answers: { name: "Ada" } })).status).toBe(404); // off until the owner turns it on
    await t.owner.put(`/api/forms/${f.id}/pro`, { settings: { saveResume: true } });
    const s = await pub(t, "POST", `/api/public/forms/${f.slug}/partial`, { answers: { name: "Ada", nope: "x", msg: ["a", 3] } });
    expect(s.status).toBe(200);
    const back = await pub(t, "POST", `/api/public/forms/${f.slug}/partial/load`, { resume: s.body.resume });
    expect(back.body.answers).toEqual({ name: "Ada", msg: ["a"] });
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/partial/load`, { resume: s.body.resume.replace(/.$/, "0") })).status).toBe(404);
    const again = await pub(t, "POST", `/api/public/forms/${f.slug}/partial`, { answers: { name: "Ada L" }, resume: s.body.resume });
    expect(again.body.resume.split(".")[0]).toBe(s.body.resume.split(".")[0]);
    const list = await t.owner.get(`/api/forms/${f.id}/partials`);
    expect(list.body.partials).toHaveLength(1);
    expect(list.body.partials[0].answers.name).toBe("Ada L");
    expect((await send(t, f.slug, A(1), { td7Resume: again.body.resume })).status).toBe(200);
    expect((await t.owner.get(`/api/forms/${f.id}/partials`)).body.partials).toHaveLength(0);
    const old = await pub(t, "POST", `/api/public/forms/${f.slug}/partial`, { answers: { name: "Late" } });
    t.advance(8 * 24 * 60 * 60_000);
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/partial/load`, { resume: old.body.resume })).status).toBe(404);
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/partial`, { answers: { msg: "x".repeat(70_000) } })).body.answers).toBeUndefined();
  });

  it("counts views, starts, reach and completions without cookies", async () => {
    const t = await setup();
    const f = await makeForm(t);
    for (const ev of [{ kind: "view" }, { kind: "view" }, { kind: "start" }, { kind: "reach", field: "name" }, { kind: "reach", field: "email" }]) {
      const r = await pub(t, "POST", `/api/public/forms/${f.slug}/events`, ev);
      expect(r.status).toBe(204);
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/events`, { kind: "reach", field: "../x" })).status).toBe(422);
    expect((await pub(t, "POST", `/api/public/forms/${f.slug}/events`, { kind: "boom" })).status).toBe(422);
    await send(t, f.slug, A(1));
    const a = await t.owner.get(`/api/forms/${f.id}/analytics`);
    expect(a.body.totals).toEqual({ views: 2, starts: 1, completions: 1 });
    expect(a.body.completionRate).toBe(50);
    expect(a.body.questions.map((q: { reached: number }) => q.reached)).toEqual([1, 1, 0]);
  });

  it("owner only: members 403, other workspace 404, signed out 401", async () => {
    const t = await setup();
    const f = await makeForm(t);
    const other = new Client(t.app);
    await other.signup("bob@other.io", "Bob", "Other");
    expect((await other.get(`/api/forms/${f.id}/pro`)).status).toBe(404);
    expect((await other.put(`/api/forms/${f.id}/pro`, { password: "Takeover 123" })).status).toBe(404);
    expect((await other.get(`/api/forms/${f.id}/analytics`)).status).toBe(404);
    const out = new Client(t.app);
    expect((await out.get(`/api/forms/${f.id}/pro`)).status).toBe(401);
    const invite = await t.owner.post("/api/team/invites", { email: "mate@acme.io", role: "member" });
    const mate = new Client(t.app);
    await mate.signup("mate@acme.io", "Mate", "Mate co");
    await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`);
    expect([403, 404]).toContain((await mate.get(`/api/forms/${f.id}/pro`)).status);
  });

  it("AI draft: no key or AI off means no provider call, with a manual path", async () => {
    const t = await setup();
    const fetchSpy = vi.fn();
    t.deps.fetch = fetchSpy as unknown as typeof fetch;
    const r = await t.owner.post("/api/forms/td7/ai-draft", { prompt: "An event signup with meal choice" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("ai_no_key");
    expect(r.body.error.message).toMatch(/paste your questions/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await t.owner.post("/api/forms/td7/ai-draft", { prompt: "x" })).status).toBe(422);
  });

  it("AI draft: workspace AI switch off means 409 ai_off and no provider call", async () => {
    const t = await setup({ FORMS_TD7: "on", ASK_TD1: "on", APP_URL: "http://localhost" });
    const fetchSpy = vi.fn();
    t.deps.fetch = fetchSpy as unknown as typeof fetch;
    expect((await t.owner.put("/api/ai-trust", { enabled: false })).status).toBe(200);
    const r = await t.owner.post("/api/forms/td7/ai-draft", { prompt: "A volunteer signup form" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("ai_off");
    expect(fetchSpy).not.toHaveBeenCalled();
    // import still works with AI off: it is plain parsing on the page
    expect(parseImport("Your name *\nEmail").fields).toHaveLength(2);
  });

  it("AI draft on built in AI with no key: one metered call, no paid call; AI switch off stops it; no binding means no_key", async () => {
    const t = await setup({ FORMS_TD7: "on", AI_CONNECT_AI2: "on", ASK_TD1: "on", APP_URL: "http://localhost" });
    const fetchSpy = vi.fn();
    t.deps.fetch = fetchSpy as unknown as typeof fetch;
    let builtinCalls = 0;
    const answer = JSON.stringify({ name: "Volunteer signup", description: "Join us", fields: [{ label: "Your name", type: "text", required: true }, { label: "Shirt size", type: "select", required: false, options: ["S", "M", "L"] }] });
    (t.deps as { ai?: unknown }).ai = { run: async () => { builtinCalls++; return { response: answer, usage: { prompt_tokens: 40, completion_tokens: 60 } }; } };
    const r = await t.owner.post("/api/forms/td7/ai-draft", { prompt: "A volunteer signup form" });
    expect(r.status).toBe(200);
    expect(r.body.draft.fields.length).toBe(2);
    expect(builtinCalls).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await t.owner.put("/api/ai-trust", { enabled: false })).status).toBe(200);
    const off = await t.owner.post("/api/forms/td7/ai-draft", { prompt: "A volunteer signup form" });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("ai_off");
    expect(builtinCalls).toBe(1);
    expect((await t.owner.put("/api/ai-trust", { enabled: true })).status).toBe(200);
    (t.deps as { ai?: unknown }).ai = undefined;
    const none = await t.owner.post("/api/forms/td7/ai-draft", { prompt: "A volunteer signup form" });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("ai_no_key");
    expect(builtinCalls).toBe(1);
  });

  it("brand logo comes only from the workspace logo, on our origin", async () => {
    const t = await setup();
    const f = await makeForm(t);
    expect((await pub(t, "GET", `/api/public/forms/${f.slug}/logo`)).status).toBe(404);
    await t.owner.put(`/api/forms/${f.id}/pro`, { settings: { brand: { logo: "mark", accent: "forest" } } });
    const g = await pub(t, "GET", `/api/public/forms/${f.slug}`);
    expect(g.body.form.td7.brand.accent).toBe("forest");
    expect(g.body.form.td7.logo).toBe(true);
    expect((await pub(t, "GET", `/api/public/forms/${f.slug}/logo`)).status).toBe(404); // no workspace logo yet
  });
});
