import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { STARTERS, type ProjectTemplateData } from "@/server/services/suite/templates";

/** R55 (plan idea 24): four starters for a young team. Each makes a project with its statuses, fields and tasks. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;

beforeEach(async () => {
  ctx = await makeTestApp();
  let clock = new Date("2026-10-20T00:00:00.000Z").getTime();
  ctx.deps.now = () => new Date((clock += 1000));
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

const NEW = ["starter-sprint", "starter-hiring", "starter-launch", "starter-support-desk"];

describe("R55 starter templates", () => {
  it("every starter task names a status its project has, and the copy has no long dashes", () => {
    for (const s of STARTERS) {
      expect(`${s.name} ${s.description} ${JSON.stringify(s.data)}`, s.id).not.toMatch(/[\u2013\u2014]/);
      if (s.kind !== "project") continue;
      const d = s.data as ProjectTemplateData;
      const names = new Set((d.project.statuses ?? []).map((x) => x.name));
      for (const t of d.tasks) if (t.status) expect(names.has(t.status), `${s.id}: ${t.title}`).toBe(true);
      expect(d.project.statuses?.some((x) => x.category === "done"), s.id).toBe(true);
    }
  });

  it("lists the four new starters with their task counts", async () => {
    const list = (await c.get("/api/templates")).body.templates as { id: string; builtin: boolean; taskCount: number; category: string }[];
    const got = Object.fromEntries(list.filter((t) => NEW.includes(t.id)).map((t) => [t.id, t.taskCount]));
    expect(got).toEqual({ "starter-sprint": 5, "starter-hiring": 5, "starter-launch": 6, "starter-support-desk": 4 });
  });

  it.each(NEW)("%s makes a project with its statuses, fields and tasks", async (id) => {
    const starter = STARTERS.find((s) => s.id === id)!;
    const d = starter.data as ProjectTemplateData;
    const used = await c.post(`/api/templates/${id}/use`, { startDate: "2026-11-02" });
    expect(used.status).toBe(201);
    expect(used.body.project.statuses.map((s: { name: string }) => s.name)).toEqual(d.project.statuses!.map((s) => s.name));
    const tasks = (await c.get(`/api/tasks?projectId=${used.body.project.id}`)).body.tasks as { title: string; statusName: string; due: string | null; repeat: unknown }[];
    expect(tasks.map((t) => t.title).sort()).toEqual(d.tasks.map((t) => t.title).sort());
    for (const t of d.tasks) {
      const made = tasks.find((x) => x.title === t.title)!;
      if (t.status) expect(made.statusName).toBe(t.status);
      if (t.dueInDays != null) expect(made.due).toBe(new Date(Date.UTC(2026, 10, 2 + t.dueInDays)).toISOString());
      if (t.repeat) expect(made.repeat).toMatchObject({ freq: t.repeat.freq });
    }
    const fields = (await c.get(`/api/fields?projectId=${used.body.project.id}`)).body.fields.map((f: { name: string }) => f.name);
    expect(fields).toEqual((d.fields ?? []).map((f) => f.name));
  });

  it("the launch day checks come with their checklist", async () => {
    const used = await c.post("/api/templates/starter-launch/use", {});
    const tasks = (await c.get(`/api/tasks?projectId=${used.body.project.id}`)).body.tasks as { id: string; title: string; checklist: { total: number; done: number } }[];
    expect(tasks.find((t) => t.title === "Launch day checks")!.checklist).toEqual({ total: 4, done: 0 });
  });
});
