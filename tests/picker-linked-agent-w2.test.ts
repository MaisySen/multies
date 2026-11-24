import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * Round 2 (PR 23 leftover): an AI agent member linked to a mail agent (R26 inbox link) showed twice in the assignee and
 * mention pickers, once as the member and once as the agent. The pickers now show the pair once, as the member. A
 * paused member leaves the pickers, so its agent shows again. Names (no pickers) keep both.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let c: Client;
beforeEach(async () => {
  ctx = await makeTestApp();
  c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
});

describe("Round 2: pickers show a linked agent and member once", () => {
  it("keeps the member entry, drops the linked agent; an unlinked agent stays; a paused member gives way", async () => {
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
    const { body } = await c.get(`/api/domains/${domainId}`);
    for (const r of body.domain.records) {
      if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
      else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
    }
    await c.post(`/api/domains/${domainId}/verify`);
    const scout = (await c.post("/api/agents", { name: "Scout", localPart: "scout" })).body.agent;
    const other = (await c.post("/api/agents", { name: "Other", localPart: "other" })).body.agent;
    const member = (await c.post("/api/team/agents", { name: "Scout", inboxAgentId: scout.id })).body.member;
    const ids = async () => ((await c.get("/api/tasks/assignees")).body.assignees as { id: string; isAgent?: boolean }[]);
    let list = await ids();
    expect(list.map((a) => a.id)).toContain(`member:${member.userId}`);
    expect(list.map((a) => a.id)).not.toContain(`agent:${scout.id}`);
    expect(list.find((a) => a.id === `agent:${other.id}`)).toMatchObject({ isAgent: true });
    // Paused: the member leaves the pickers, so the agent is back.
    await c.patch(`/api/team/agents/${member.userId}`, { disabled: true });
    list = await ids();
    expect(list.map((a) => a.id)).toContain(`agent:${scout.id}`);
  });
});
