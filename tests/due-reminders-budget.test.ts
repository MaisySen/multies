import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { REMINDER_BUDGET, runDueReminders } from "@/server/services/suite/automations";

// Regression for Sentry MYMAIL-API-C: the five minute maintenance run passed the Workers
// limit on calls per invocation once many workspaces had due date rules.
describe("due date reminders stay inside a per run budget", () => {
  it("sends at most the budget per run and the rest on the next run", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const me = (await c.get("/api/account/me")).body.user;
    await c.post("/api/automations", { name: "Due", trigger: "due_soon", conditions: { hoursBefore: 24 }, action: "notify", actionConfig: { to: "assignee" } });
    const total = REMINDER_BUDGET + 5;
    for (let i = 0; i < total; i++) {
      expect((await c.post("/api/tasks", { title: `Task ${i}`, assignee: `member:${me.id}`, due: new Date(Date.now() + 3 * 3600_000).toISOString() })).status).toBe(201);
    }
    const first = (await runDueReminders(ctx.deps)).sent;
    expect(first).toBe(REMINDER_BUDGET);
    expect((await runDueReminders(ctx.deps)).sent).toBe(total - REMINDER_BUDGET);
    expect((await runDueReminders(ctx.deps)).sent).toBe(0);
  });

  it("sends no reminders in demo workspaces", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(ctx.app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const me = (await c.get("/api/account/me")).body.user;
    await c.post("/api/automations", { name: "Due", trigger: "due_soon", conditions: { hoursBefore: 24 }, action: "notify", actionConfig: { to: "assignee" } });
    await c.post("/api/tasks", { title: "Sample", assignee: `member:${me.id}`, due: new Date(Date.now() + 3 * 3600_000).toISOString() });
    expect((await runDueReminders(ctx.deps)).sent).toBe(0);
  });
});
