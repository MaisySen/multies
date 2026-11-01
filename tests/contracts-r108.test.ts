import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { breadcrumbs } from "@/web/layouts/shell-nav";
import {
  CONTRACT_NOTE, STANDARD_CLAUSES, STANDARD_TEMPLATES, addYears, applyConditions, buildContract, checkAnswers, checkClauseBody, contractHtml, contractMarkdown,
  displayValue, plannedReminders, standardClause, standardTemplate, startingAnswers, testCondition, unknownPlaceholders, validAbn, validDate, visibleQuestions,
  type ClauseText,
} from "@/shared/contracts-r108";

/** R108 contracts: templates, interview branching and checks, conditional clauses, clause versions, reminders and permissions. */
const ctx = { workspaceName: "Acme", today: "2026-11-01" };
const std = new Map<string, ClauseText>(STANDARD_CLAUSES.map((c) => [c.key, { ...c, version: 0 }]));
const svc = standardTemplate("std-service")!;
const serviceAnswers = (extra: Record<string, string> = {}) => ({ ...startingAnswers(svc, ctx), client_name: "Bright Bakery", services: "Build a website", fee_type: "fixed", fee_amount: "4500", end_date: "2027-10-31", ...extra });

describe("contract rules", () => {
  it("every standard template only uses clauses that exist, read cleanly and fill from its own questions", () => {
    for (const t of STANDARD_TEMPLATES) {
      for (const r of t.clauses) {
        const c = standardClause(r.key);
        expect(c, `${t.id} ${r.key}`).not.toBeNull();
        expect(checkClauseBody(c!.body), r.key).toBeNull();
        expect(unknownPlaceholders(t, c!.body), `${t.id} ${r.key}`).toEqual([]);
      }
      expect(t.description).not.toMatch(/[\u2013\u2014]/);
    }
  });
  it("reads conditions without eval", () => {
    expect(testCondition("has_end", { has_end: "yes" })).toBe(true);
    expect(testCondition("has_end", { has_end: "no" })).toBe(false);
    expect(testCondition("not auto_renew", {})).toBe(true);
    expect(testCondition("fee_type = hourly", { fee_type: "hourly" })).toBe(true);
    expect(testCondition("fee_type != hourly", { fee_type: "hourly" })).toBe(false);
    expect(testCondition("constructor.prototype", {})).toBeNull();
    expect(testCondition("x); alert(1", {})).toBeNull();
  });
  it("branches the interview: hidden questions are not asked and not checked", () => {
    const a = serviceAnswers({ has_end: "no", end_date: "" });
    expect(visibleQuestions(svc, a).map((x) => x.key)).not.toContain("end_date");
    expect(visibleQuestions(svc, a).map((x) => x.key)).not.toContain("notice_days");
    expect(checkAnswers(svc, a)).toEqual({});
    const b = serviceAnswers({ has_end: "yes", end_date: "", auto_renew: "yes" });
    expect(visibleQuestions(svc, b).map((x) => x.key)).toEqual(expect.arrayContaining(["end_date", "notice_days"]));
    expect(checkAnswers(svc, b).end_date).toBe("Fill this in.");
  });
  it("checks answers: required, email, money, numbers, dates, ABN and end after start", () => {
    const e = checkAnswers(svc, serviceAnswers({ client_name: "", fee_amount: "lots", payment_days: "200", end_date: "2026-10-01", provider_abn: "12345678901", fee_type: "weekly" }));
    expect(e.client_name).toBe("Fill this in.");
    expect(e.fee_amount).toBe("Enter an amount like 1500.");
    expect(e.payment_days).toBe("Use 120 or less.");
    expect(e.end_date).toBe("This needs to be after the start date.");
    expect(e.provider_abn).toMatch(/ABN/);
    expect(e.fee_type).toBe("Choose one of the answers.");
    const priv = standardTemplate("std-privacy")!;
    expect(checkAnswers(priv, { ...startingAnswers(priv, ctx), contact_email: "nope" }).contact_email).toMatch(/email address/);
    expect(validAbn("51 824 753 556")).toBe(true);
    expect(validAbn("51 824 753 557")).toBe(false);
    expect(validDate("2026-02-30")).toBe(false);
  });
  it("fills starting answers from the workspace and today", () => {
    const a = startingAnswers(svc, ctx);
    expect(a.provider_name).toBe("Acme");
    expect(a.start_date).toBe("2026-11-01");
  });
  it("keeps or drops clauses and paragraphs by the answers", () => {
    const hourly = buildContract(svc, std, serviceAnswers({ fee_type: "hourly", fee_amount: "120", ip_owner: "provider" }), ctx);
    const text = hourly.clauses.map((c) => c.paragraphs.join("\n")).join("\n");
    expect(text).toContain("$120 an hour (plus GST)");
    expect(text).not.toContain("fixed fee");
    expect(hourly.clauses.map((c) => c.key)).toContain("ip_provider");
    expect(hourly.clauses.map((c) => c.key)).not.toContain("ip_client");
    expect(text).toContain("31 October 2027");
    expect(hourly.clauses[0].heading).toBe("1. The services");
    expect(applyConditions("a\n[[if x]]\nb\n[[if y]]\nc\n[[end]]\n[[end]]\nd", { x: "yes" })).toBe("a\nb\nd");
    expect(applyConditions("start[[if x]], more[[end]].", {})).toBe("start.");
  });
  it("puts a blank line for anything not answered and escapes everything in the PDF", () => {
    const m = new Map(std);
    m.set("entire", { key: "entire", title: "Extra", body: "Ask {{mystery}} <script>x</script>", version: 3 });
    const b = buildContract(svc, m, serviceAnswers({ client_name: "<b>Evil</b> & Co" }), ctx);
    const html = contractHtml(b);
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<b>Evil");
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt; &amp; Co");
    expect(html).toContain("________________");
    expect(b.clauses.find((c) => c.key === "entire")!.version).toBe(3);
  });
  it("carries the not legal advice note on the PDF and the Doc", () => {
    const b = buildContract(svc, std, serviceAnswers(), ctx);
    expect(contractHtml(b)).toContain(CONTRACT_NOTE);
    const md = contractMarkdown(b);
    expect(md.startsWith(`> **${CONTRACT_NOTE}**`)).toBe(true);
    expect(md.trim().endsWith(`*${CONTRACT_NOTE}*`)).toBe(true);
  });
  it("shows answers in words: dates, money, ABN and choices", () => {
    const a = serviceAnswers({ provider_abn: "51824753556", state: "VIC" });
    expect(displayValue(svc, "provider_abn", a, ctx)).toBe("51 824 753 556");
    expect(displayValue(svc, "fee_amount", a, ctx)).toBe("$4,500");
    expect(displayValue(svc, "state", a, ctx)).toBe("Victoria");
    expect(displayValue(svc, "gst", a, ctx)).toBe("plus GST");
    expect(displayValue(svc, "start_date", a, ctx)).toBe("1 November 2026");
  });
  it("plans renewal and end date reminders, marking past dates", () => {
    const r = plannedReminders(svc, serviceAnswers({ auto_renew: "yes", notice_days: "30" }), ctx, "T");
    expect(r.map((x) => [x.due, x.title])).toEqual([["2027-09-24", "Decide on renewal before the notice date: T"], ["2027-10-31", "Agreement ends: T"]]);
    const noRenew = plannedReminders(svc, serviceAnswers({ auto_renew: "no" }), ctx, "T");
    expect(noRenew.map((x) => x.due)).toEqual(["2027-10-01", "2027-10-31"]);
    expect(plannedReminders(svc, serviceAnswers({ has_end: "no" }), ctx, "T")).toEqual([]);
    const nda = standardTemplate("std-nda")!;
    expect(plannedReminders(nda, { ...startingAnswers(nda, ctx), years: "3" }, ctx, "N")[0].due).toBe("2029-11-01");
    expect(plannedReminders(svc, serviceAnswers({ start_date: "2020-01-01", end_date: "2020-06-01" }), ctx, "T").every((x) => x.past)).toBe(true);
    expect(addYears("2028-02-29", 1)).toBe("2029-03-01");
  });
  it("refuses broken clause tests", () => {
    expect(checkClauseBody("[[if x]]\nhi")).toMatch(/needs an \[\[end\]\]/);
    expect(checkClauseBody("hi\n[[end]]")).toMatch(/without an \[\[if\]\]/);
    expect(checkClauseBody("[[if 1bad]]\nx\n[[end]]")).toMatch(/can't be read/);
    expect(checkClauseBody("a [[if x]]b")).toMatch(/same line/);
    expect(checkClauseBody("a [[if x]]b[[end]] c")).toBeNull();
  });
});

describe("contracts api", () => {
  let app: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: Client;
  beforeEach(async () => {
    app = await makeTestApp({ CONTRACTS_R108: "on" });
    owner = new Client(app.app);
    await owner.signup("owner@acme.io", "Olive Owner");
  });
  async function member(role: "member" | "admin" = "member", email = "mate@acme.io") {
    const invite = await owner.post("/api/team/invites", { email, role });
    const m = new Client(app.app);
    await m.signup(email, "Sam Mate", "");
    expect((await m.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    return m;
  }
  const answers = { client_name: "Bright Bakery", services: "Build a website", fee_type: "fixed", fee_amount: "4500", end_date: "2030-10-31", has_end: "yes", auto_renew: "no", provider_name: "Acme", gst: "plus", payment_days: "14", start_date: "2030-01-01", termination_days: "30", ip_owner: "client", state: "NSW" };

  it("is off unless the flag is on, and needs a session", async () => {
    const off = await makeTestApp();
    const c = new Client(off.app);
    await c.signup("x@acme.io", "X");
    expect((await c.get("/api/contracts")).status).toBe(404);
    expect((await new Client(app.app).get("/api/contracts")).status).toBe(401);
    expect((await c.get("/api/config")).body.contractsR108).toBeFalsy();
    expect((await owner.get("/api/config")).body.contractsR108).toBe(true);
  });
  it("lists the five standard templates with the note", async () => {
    const r = await owner.get("/api/contracts");
    expect(r.status).toBe(200);
    expect(r.body.templates.filter((t: { builtIn: boolean }) => t.builtIn)).toHaveLength(5);
    expect(r.body.note).toBe(CONTRACT_NOTE);
    expect(r.body.canManage).toBe(true);
  });
  it("a member generates a contract as a Doc with reminder tasks, and sees it in their recent list", async () => {
    const m = await member();
    const bad = await m.post("/api/contracts/generate", { templateId: "std-service", answers: { ...answers, client_name: "" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.errors.client_name).toBe("Fill this in.");
    const r = await m.post("/api/contracts/generate", { templateId: "std-service", answers, reminders: true });
    expect(r.status).toBe(201);
    expect(r.body.doc.title).toBe("Service agreement: Acme and Bright Bakery");
    expect(r.body.tasks.map((t: { due: string }) => t.due)).toEqual(["2030-10-01", "2030-10-31"]);
    const doc = await m.get(`/api/docs/${r.body.doc.id}`);
    expect(doc.status).toBe(200);
    expect(JSON.stringify(doc.body)).toContain(CONTRACT_NOTE);
    const mine = await m.get("/api/contracts");
    expect(mine.body.recent[0].title).toBe("Service agreement: Acme and Bright Bakery");
    expect(mine.body.recent[0].reminders).toBe(2);
    expect((await owner.get("/api/contracts")).body.recent).toHaveLength(0);
    expect(mine.body.canManage).toBe(false);
  });
  it("only admins add, edit or retire templates and clauses", async () => {
    const m = await member();
    expect((await m.post("/api/contracts/templates", { baseId: "std-nda", name: "Our NDA", clauseKeys: ["nda_purpose"] })).status).toBe(403);
    expect((await m.put("/api/contracts/clauses/law", { title: "Law", body: "Victoria only." })).status).toBe(403);
    expect((await m.post("/api/contracts/clauses/law/retire")).status).toBe(403);
    const admin = await member("admin", "boss@acme.io");
    const t = await admin.post("/api/contracts/templates", { baseId: "std-nda", name: "Our NDA", description: "Short", clauseKeys: ["nda_purpose", "nda_term", "law"] });
    expect(t.status).toBe(201);
    expect((await m.post(`/api/contracts/templates/${t.body.id}/retire`)).status).toBe(403);
    expect((await owner.post(`/api/contracts/templates/${t.body.id}/retire`)).status).toBe(200);
    expect((await m.get("/api/contracts")).body.templates.some((x: { id: string }) => x.id === t.body.id)).toBe(false);
    expect((await m.get(`/api/contracts/templates/${t.body.id}`)).status).toBe(404);
    expect((await owner.get("/api/contracts")).body.templates.find((x: { id: string }) => x.id === t.body.id).retired).toBe(true);
    expect((await owner.post("/api/contracts/templates/std-nda/retire")).status).toBe(400);
  });
  it("keeps clause versions: the newest is used, history stays, retired clauses are skipped", async () => {
    const v1 = await owner.put("/api/contracts/clauses/law", { title: "Which law applies", body: "Only the law of {{state}} applies." });
    expect(v1.body.version).toBe(1);
    const v2 = await owner.put("/api/contracts/clauses/law", { title: "Which law applies", body: "The law of {{state}} applies, version two." });
    expect(v2.body.version).toBe(2);
    const list = (await owner.get("/api/contracts/clauses")).body.clauses as { key: string; version: number; history: { version: number }[] }[];
    expect(list.find((c) => c.key === "law")!.history.map((h) => h.version)).toEqual([2, 1, 0]);
    const d = await owner.get("/api/contracts/templates/std-service");
    expect(d.body.clauses.find((c: { key: string }) => c.key === "law").body).toContain("version two");
    expect((await owner.put("/api/contracts/clauses/law", { title: "x", body: "[[if state]]\nno end" })).status).toBe(400);
    expect((await owner.post("/api/contracts/clauses/entire/retire")).status).toBe(200);
    const after = await owner.get("/api/contracts/templates/std-service");
    expect(after.body.clauses.map((c: { key: string }) => c.key)).not.toContain("entire");
    expect(after.body.skipped).toContain("entire");
    expect((await owner.post("/api/contracts/clauses/entire/restore")).status).toBe(200);
    const custom = await owner.post("/api/contracts/clauses", { title: "Late fees", body: "Late invoices attract a fee of {{late_fee}}." });
    expect(custom.status).toBe(201);
    expect(custom.body.key).toBe("ws_late_fees");
    const t = await owner.post("/api/contracts/templates", { baseId: "std-service", name: "Agency agreement", clauseKeys: ["svc_services", "svc_fees", "ws_late_fees"] });
    expect(t.body.warnings).toEqual(["late_fee"]);
    const gen = await owner.post("/api/contracts/generate", { templateId: t.body.id, answers });
    expect(gen.status).toBe(201);
    const runs = (await owner.get("/api/contracts")).body.recent;
    expect(runs[0].templateId).toBe(t.body.id);
  });
  it("another workspace can't see or use our templates", async () => {
    const t = await owner.post("/api/contracts/templates", { baseId: "std-nda", name: "Our NDA", clauseKeys: ["nda_purpose"] });
    const other = new Client(app.app);
    await other.signup("x@other.io", "Other", "Other Co");
    expect((await other.get(`/api/contracts/templates/${t.body.id}`)).status).toBe(404);
    expect((await other.post("/api/contracts/generate", { templateId: t.body.id, answers: {} })).status).toBe(404);
    expect((await other.put(`/api/contracts/templates/${t.body.id}`, { name: "Mine", clauseKeys: ["law"] })).status).toBe(404);
  });
});

describe("R108 contracts breadcrumb (verifier v13 low)", () => {
  it("the Contracts view of Tools > Templates names itself", () => {
    expect(breadcrumbs("/app/tools/templates", "?view=contracts").map((c) => c.label).at(-1)).toBe("Contracts");
    expect(breadcrumbs("/app/tools/templates", "").map((c) => c.label).at(-1)).toBe("Invoice and letter templates");
  });
});
