import { describe, expect, it } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { LOOSEN_AFTER, suggestMode, tallyRecord, type TrackRecord } from "@/server/services/agents/autonomy";

const rows = (...s: string[]) => s.map((status, i) => ({ id: `apr_${i}`, status }));

describe("tallyRecord", () => {
  it("counts each outcome and the clean streak from the newest request", () => {
    const r = tallyRecord(rows("pending", "sent", "sent", "failed", "sent", "rejected", "sent"), new Set(["apr_4"]));
    expect(r).toMatchObject({ pending: 1, decided: 6, approvedAsIs: 3, approvedEdited: 1, rejected: 1, failed: 1, expired: 0 });
    // sent, sent, (failed skipped), then the edited one ends the streak.
    expect(r.cleanStreak).toBe(2);
  });
  it("has no streak when the newest decision was rejected or expired", () => {
    expect(tallyRecord(rows("rejected", "sent", "sent"), new Set()).cleanStreak).toBe(0);
    expect(tallyRecord(rows("expired", "sent"), new Set()).cleanStreak).toBe(0);
  });
});

describe("suggestMode", () => {
  const rec = (p: Partial<TrackRecord>): TrackRecord => ({ window: 50, decided: 0, approvedAsIs: 0, approvedEdited: 0, rejected: 0, expired: 0, failed: 0, pending: 0, cleanStreak: 0, ...p });
  it("offers the next step up only after a clean streak", () => {
    expect(suggestMode("always", rec({ decided: 19, approvedAsIs: 19, cleanStreak: 19 }))).toBeNull();
    expect(suggestMode("always", rec({ decided: 20, approvedAsIs: 20, cleanStreak: LOOSEN_AFTER.always }))).toMatchObject({ mode: "external", direction: "loosen" });
    expect(suggestMode("external", rec({ decided: 49, approvedAsIs: 49, cleanStreak: 49 }))).toBeNull();
    expect(suggestMode("external", rec({ decided: 50, approvedAsIs: 50, cleanStreak: 50 }))).toMatchObject({ mode: "never", direction: "loosen" });
    expect(suggestMode("never", rec({}))).toBeNull();
  });
  it("suggests tightening after repeated rejections, and never loosens past them", () => {
    expect(suggestMode("external", rec({ decided: 10, approvedAsIs: 7, rejected: 3 }))).toMatchObject({ mode: "always", direction: "tighten" });
    expect(suggestMode("external", rec({ decided: 40, approvedAsIs: 37, rejected: 3 }))).toBeNull();
    expect(suggestMode("always", rec({ decided: 10, rejected: 5 }))).toBeNull();
  });
});

describe("GET /api/agents/:id/track-record", () => {
  it("reports approvals as written, edited and rejected, and writes nothing", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    const wsKey = (await c.post("/api/developer/keys", { name: "Agents" })).body.secret;
    const v1 = async (key: string, method: string, path: string, b?: unknown) => {
      const res = await ctx.app.request(`/api/v1${path}`, { method, headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return res.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const { agent, apiKey } = await v1(wsKey, "POST", "/agents", { name: "Outreach", approvalMode: "always", sendCapDaily: 50 });
    const ids: string[] = [];
    for (const s of ["one", "two", "three"]) ids.push((await v1(apiKey.secret, "POST", `/agents/${agent.id}/send`, { to: ["lead@example.com"], subject: s, text: s })).approval.id);
    expect((await c.post(`/api/approvals/${ids[0]}/approve`, {})).status).toBe(200);
    expect((await c.post(`/api/approvals/${ids[1]}/approve`, { text: "Edited" })).status).toBe(200);
    expect((await c.post(`/api/approvals/${ids[2]}/reject`, { note: "No" })).status).toBe(200);

    const changes = () => ((ctx.db as unknown as { $client: { prepare: (q: string) => { get: () => unknown } } }).$client.prepare("select total_changes() as n").get() as { n: number }).n;
    const before = changes();
    const res = await c.get(`/api/agents/${agent.id}/track-record`);
    expect(changes()).toBe(before);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "always", record: { decided: 3, approvedAsIs: 1, approvedEdited: 1, rejected: 1, cleanStreak: 0 }, suggestion: null });
    expect((await c.get("/api/agents/agt_missing/track-record")).status).toBe(404);
  });
});
