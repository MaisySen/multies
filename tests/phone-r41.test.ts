import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { eq } from "drizzle-orm";
import { mailConnections } from "@/server/db/schema";
import { quarterHourSlots, formatSlot } from "@/web/components/ui/phone-picker";

describe("R41 phone polish and demo", () => {
  it("Reconnect puts the demo's sample mailbox back to healthy without a provider check or a stored password", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(ctx.app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const conns = (await c.get("/api/connections")).body.connections;
    expect(conns[0].sample).toBe(true);
    const id = conns[0].id as string;
    await ctx.db.update(mailConnections).set({ status: "error", lastError: "Something broke" }).where(eq(mailConnections.id, id));
    const r = await c.put(`/api/connections/${id}`, { password: "sample" });
    expect(r.status).toBe(200);
    expect(r.body.connection.status).toBe("active");
    expect(r.body.connection.lastError).toBeNull();
    const row = (await ctx.db.query.mailConnections.findMany())[0]!;
    expect(row.secretEnc).toBe("sample:none");
  });

  it("demo workspaces still refuse invites on the server", async () => {
    const ctx = await makeTestApp({ DEMO_MODE: "true" });
    const c = new Client(ctx.app);
    expect((await c.post("/api/account/demo")).status).toBe(201);
    const r = await c.post("/api/team/invites", { email: "someone@example.com", role: "member", mailboxIds: [] });
    expect(r.status).toBe(403);
    expect(r.body.error?.code ?? r.body.code).toBe("demo_invites_off");
  });

  it("time sheets offer every quarter hour and keep a value in the person's format", () => {
    const s = quarterHourSlots();
    expect(s).toHaveLength(96);
    expect(s[0]).toBe("00:00");
    expect(s[37]).toBe("09:15");
    expect(s[95]).toBe("23:45");
    expect(formatSlot("09:30")).toMatch(/9:30/);
    expect(formatSlot("bad")).toBe("bad");
  });
});
