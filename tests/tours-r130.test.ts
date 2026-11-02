import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import {
  audienceMatches, BUILTIN_TOURS, checklistFor, checklistView, checklistVisible, inApp, isMarkable, navTourId, pageMatches, parseChecklist,
  ProgressInput, TourInput, TourStep,
} from "@/shared/tours-r130";
import { isToursExcluded } from "@/server/services/tours-r130";

describe("R130 tours: rules", () => {
  it("admins and members get different checklists; sites only when that area is on", () => {
    expect(checklistFor("owner").map((s) => s.id)).toEqual(["mail", "invite", "task", "palette", "tour"]);
    expect(checklistFor("admin", { sites: true }).map((s) => s.id)).toEqual(["mail", "invite", "task", "site", "palette", "tour"]);
    expect(checklistFor("member").map((s) => s.id)).toEqual(["open_mail", "task", "doc", "palette", "tour"]);
    for (const r of ["owner", "member"]) { const n = checklistFor(r, { sites: true }).length; expect(n).toBeGreaterThanOrEqual(5); expect(n).toBeLessThanOrEqual(7); }
  });
  it("only app observed steps can be marked; data steps complete from real rows", () => {
    expect(["palette", "tour", "open_mail"].every(isMarkable)).toBe(true);
    expect(["mail", "invite", "task", "doc", "site", "nope"].some(isMarkable)).toBe(false);
  });
  it("progress view counts, completes and hides after the all set moment", () => {
    const defs = checklistFor("member");
    const v = checklistView(defs, parseChecklist({ done: ["task", "doc", "bogus", "task"] }));
    expect(v.doneCount).toBe(2); expect(v.total).toBe(5); expect(v.complete).toBe(false); expect(checklistVisible(v)).toBe(true);
    const all = checklistView(defs, { done: defs.map((d) => d.id), dismissed: false, celebrated: false });
    expect(all.complete).toBe(true); expect(checklistVisible(all)).toBe(true);
    expect(checklistVisible({ ...all, celebrated: true })).toBe(false);
    expect(checklistVisible({ ...v, dismissed: true })).toBe(false);
    expect(parseChecklist("junk")).toEqual({ done: [], dismissed: false, celebrated: false });
  });
  it("audience: all, admins, members, and new in the last N days", () => {
    const now = Date.UTC(2026, 10, 2); const day = 86_400_000;
    const admin = { role: "admin", joinedAt: now - 40 * day }; const fresh = { role: "member", joinedAt: now - 2 * day };
    expect(audienceMatches({ audience: "all", newDays: null }, admin, now)).toBe(true);
    expect(audienceMatches({ audience: "admins", newDays: null }, fresh, now)).toBe(false);
    expect(audienceMatches({ audience: "members", newDays: null }, admin, now)).toBe(false);
    expect(audienceMatches({ audience: "members", newDays: 7 }, fresh, now)).toBe(true);
    expect(audienceMatches({ audience: "all", newDays: 30 }, admin, now)).toBe(false);
  });
  it("pages: a tour runs on its page and sub pages, and never outside the app", () => {
    expect(pageMatches("/app/tasks", "/app/tasks")).toBe(true);
    expect(pageMatches("/app/tasks", "/app/tasks/")).toBe(true);
    expect(pageMatches("/app/tasks", "/app/tasks/board")).toBe(true);
    expect(pageMatches("/app/tasks", "/app/tasksx")).toBe(false);
    expect(pageMatches("/app", "/app/tasks")).toBe(false);
    for (const p of ["/s/acme", "/blog/x", "/book/acme", "/f/form", "/report/acme", "/"]) expect(inApp(p)).toBe(false);
    expect(inApp("/app")).toBe(true);
  });
  it("targets are stable ids, never CSS paths or markup", () => {
    expect(TourStep.safeParse({ target: "rail-contacts", title: "Hi", body: "" }).success).toBe(true);
    for (const bad of ["div > a", "#main", "[data-x]", "a b", "<img>", "", "x".repeat(81)]) expect(TourStep.safeParse({ target: bad, title: "Hi", body: "" }).success).toBe(false);
    expect(TourInput.safeParse({ name: "T", page: "javascript:alert(1)" }).success).toBe(false);
    expect(TourInput.safeParse({ name: "T", page: "/s/acme" }).success).toBe(false);
    expect(TourInput.safeParse({ name: "T", page: "/app/tasks", steps: Array.from({ length: 11 }, () => ({ target: "a", title: "t", body: "" })) }).success).toBe(false);
    expect(ProgressInput.safeParse({ key: "checklist'; drop", state: "done" }).success).toBe(false);
  });
  it("built in tours follow the new navigation and use only valid ids", () => {
    expect(BUILTIN_TOURS.map((t) => t.id)).toEqual(["builtin:getting_around", "builtin:contacts", "builtin:mail_setup", "builtin:docs_files", "builtin:more_sheet"]);
    for (const t of BUILTIN_TOURS) for (const s of t.steps) expect(TourStep.safeParse(s).success).toBe(true);
    expect(navTourId("/app/contacts")).toBe("nav-app-contacts");
    expect(navTourId("/app/settings/mailboxes", "pane")).toBe("pane-app-settings-mailboxes");
  });
  it("the client workspace is always kept out", () => {
    expect(isToursExcluded({ id: "org_1", slug: "vv8k", name: "Client" })).toBe(true);
    expect(isToursExcluded({ id: "org_2", slug: "acme", name: "Acme" })).toBe(false);
    expect(isToursExcluded({ id: "org_2", slug: "acme", name: "Acme" }, "acme")).toBe(true);
  });
});

describe("R130 tours: routes", () => {
  let owner: Client; let member: Client; let other: Client;
  beforeEach(async () => {
    const ctx = await makeTestApp({ TOURS_R130: "on" } as never);
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    const invite = await owner.post("/api/team/invites", { email: "max@acme.io", role: "member" });
    member = new Client(ctx.app);
    await member.signup("max@acme.io", "Max Member", "");
    expect((await member.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    other = new Client(ctx.app);
    await other.signup("zed@other.io", "Zed Other");
  });

  it("checklist completes itself from real actions, and marks only what the app can see", async () => {
    let r = await member.get("/api/tours/me");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true); expect(r.body.canBuild).toBe(false);
    expect(r.body.checklist.steps.map((s: { id: string }) => s.id)).toEqual(["open_mail", "task", "doc", "palette", "tour"]);
    expect(r.body.checklist.doneCount).toBe(0);
    await member.post("/api/docs", { title: "Plan", text: "hello" });
    r = await member.get("/api/tours/me");
    expect(r.body.checklist.steps.find((s: { id: string }) => s.id === "doc").done).toBe(true);
    expect((await member.post("/api/tours/checklist", { action: "mark", step: "task" })).status).toBe(400); // data step: not markable
    expect((await member.post("/api/tours/checklist", { action: "mark", step: "palette" })).body.checklist.doneCount).toBe(2);
    expect((await owner.post("/api/tours/checklist", { action: "mark", step: "open_mail" })).status).toBe(400); // not on the admin list
    const o = await owner.get("/api/tours/me");
    expect(o.body.canBuild).toBe(true);
    expect(o.body.checklist.steps.find((s: { id: string }) => s.id === "invite").done).toBe(true); // the invite above
  });
  it("dismiss, resume and the all set moment", async () => {
    let r = await member.post("/api/tours/checklist", { action: "dismiss" });
    expect(r.body.checklist.dismissed).toBe(true);
    r = await member.post("/api/tours/checklist", { action: "resume" });
    expect(r.body.checklist.dismissed).toBe(false);
    r = await member.post("/api/tours/checklist", { action: "celebrated" });
    expect(r.body.checklist.celebrated).toBe(true);
  });
  it("finishing the getting around tour ticks the tour step; unknown tours are refused", async () => {
    expect((await member.post("/api/tours/progress", { key: "builtin:getting_around", state: "skipped", step: 1 })).status).toBe(200);
    const r = await member.get("/api/tours/me");
    expect(r.body.seen).toContain("builtin:getting_around");
    expect(r.body.checklist.steps.find((s: { id: string }) => s.id === "tour").done).toBe(true);
    expect((await member.post("/api/tours/progress", { key: "builtin:nope", state: "done", step: 0 })).status).toBe(404);
    expect((await member.post("/api/tours/progress", { key: "tour_missing", state: "done", step: 0 })).status).toBe(404);
  });
  it("builder: admins only; create, publish, audience, seen once, reset for a person", async () => {
    const steps = [{ target: "rail-tasks", title: "Tasks", body: "All your work." }];
    expect((await member.get("/api/tours/admin")).status).toBe(403);
    expect((await member.post("/api/tours/admin", { name: "X", page: "/app/tasks", steps })).status).toBe(403);
    let r = await owner.post("/api/tours/admin", { name: "Welcome to Tasks", page: "/app/tasks", audience: "members", steps: [] });
    expect(r.status).toBe(200);
    const id = r.body.id as string;
    expect(r.body.status).toBe("draft");
    expect((await owner.patch(`/api/tours/admin/${id}`, { status: "published" })).status).toBe(400); // no steps yet
    r = await owner.patch(`/api/tours/admin/${id}`, { steps, status: "published" });
    expect(r.body.status).toBe("published");
    expect((await member.get("/api/tours/me")).body.tours.map((t: { id: string }) => t.id)).toEqual([id]);
    expect((await owner.get("/api/tours/me")).body.tours).toEqual([]); // members only
    expect((await member.post("/api/tours/progress", { key: id, state: "skipped", step: 0 })).status).toBe(200);
    expect((await member.get("/api/tours/me")).body.tours).toEqual([]); // seen once
    const list = await owner.get("/api/tours/admin");
    const max = list.body.people.find((p: { name: string }) => p.name === "Max Member");
    expect(max).toBeTruthy();
    expect((await member.post(`/api/tours/admin/reset/${max.userId}`, { tourId: id })).status).toBe(403);
    r = await owner.post(`/api/tours/admin/reset/${max.userId}`, { tourId: id });
    expect(r.body.cleared).toBe(1);
    expect((await member.get("/api/tours/me")).body.tours.map((t: { id: string }) => t.id)).toEqual([id]);
    // Drafts are never shown.
    await owner.patch(`/api/tours/admin/${id}`, { status: "draft" });
    expect((await member.get("/api/tours/me")).body.tours).toEqual([]);
    expect((await owner.del(`/api/tours/admin/${id}`)).status).toBe(200);
    expect((await owner.get(`/api/tours/admin/${id}`)).status).toBe(404);
  });
  it("rejects CSS paths and pages outside the app on the server", async () => {
    expect((await owner.post("/api/tours/admin", { name: "Bad", page: "/app/tasks", steps: [{ target: "div > a", title: "x", body: "" }] })).status).toBe(422);
    expect((await owner.post("/api/tours/admin", { name: "Bad", page: "/s/acme", steps: [] })).status).toBe(422);
  });
  it("nothing crosses workspaces", async () => {
    const r = await owner.post("/api/tours/admin", { name: "Mine", page: "/app/tasks", steps: [{ target: "rail-tasks", title: "T", body: "" }] });
    await owner.patch(`/api/tours/admin/${r.body.id}`, { status: "published" });
    expect((await other.get(`/api/tours/admin/${r.body.id}`)).status).toBe(404);
    expect((await other.patch(`/api/tours/admin/${r.body.id}`, { name: "x" })).status).toBe(404);
    expect((await other.get("/api/tours/me")).body.tours).toEqual([]);
    expect((await other.post("/api/tours/progress", { key: r.body.id, state: "done", step: 0 })).status).toBe(404);
    const ownerId = (await owner.get("/api/tours/admin")).body.people[0].userId;
    expect((await other.post(`/api/tours/admin/reset/${ownerId}`, {})).status).toBe(404);
  });
  it("signed out gets 401", async () => {
    const ctx = await makeTestApp({ TOURS_R130: "on" } as never);
    expect((await new Client(ctx.app).get("/api/tours/me")).status).toBe(401);
  });
});

describe("R130 tours: flag off", () => {
  it("the routes do not exist", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("a@b.io", "A B");
    expect((await c.get("/api/tours/me")).status).toBe(404);
    expect((await c.get("/api/tours/admin")).status).toBe(404);
  });
});
