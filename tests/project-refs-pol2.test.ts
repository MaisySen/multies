import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

/** POL2 (HANDOVER item 6): the project References panel reads /api/mentions/refs/project with TD5's rules. */
async function setup() {
  const ctx = await makeTestApp({ MENTIONS_TD5: "on" });
  const admin = new Client(ctx.app);
  await admin.signup("pa@acme.io", "Pat Admin", "Acme");
  const inv = await admin.post("/api/team/invites", { email: "mo@acme.io", role: "member" });
  const member = new Client(ctx.app);
  await member.signup("mo@acme.io", "Mo Member", "Mo Co");
  expect((await member.post(`/api/invites/${inv.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
  const outsider = new Client(ctx.app);
  await outsider.signup("zed@other.io", "Zed Other", "Other");
  const proj = (await admin.post("/api/projects", { name: "Launch" })).body.project;
  const general = (await admin.get("/api/chat/channels")).body.channels.find((x: { name: string }) => x.name === "general");
  return { app: ctx.app, admin, member, outsider, proj, general };
}

describe("project References (POL2 item 6)", () => {
  it("lists what mentions the project; a private channel reads as restricted with no title; other workspace 404", async () => {
    const t = await setup();
    await t.admin.post(`/api/chat/channels/${t.general.id}/messages`, { body: `kickoff for <#project:${t.proj.id}>` });
    const priv = (await t.admin.post("/api/chat/channels", { name: "board-only", private: true })).body.channel;
    expect(priv?.id).toBeTruthy();
    await t.admin.post(`/api/chat/channels/${priv.id}/messages`, { body: `budget cut for <#project:${t.proj.id}>` });
    const mine = await t.member.get(`/api/mentions/refs/project/${t.proj.id}?dir=in`);
    expect(mine.status).toBe(200);
    const records = mine.body.items.map((x: { record: Record<string, unknown> }) => x.record);
    expect(records).toContainEqual(expect.objectContaining({ state: "ok", type: "channel", title: "#general" }));
    const hidden = records.find((r: { state: string }) => r.state === "restricted");
    expect(hidden).toEqual({ state: "restricted", type: "channel", id: priv.id });
    expect(JSON.stringify(mine.body)).not.toContain("board-only");
    expect(JSON.stringify(mine.body)).not.toContain("budget cut");
    expect((await t.outsider.get(`/api/mentions/refs/project/${t.proj.id}?dir=in`)).status).toBe(404);
    expect((await new Client(t.app).get(`/api/mentions/refs/project/${t.proj.id}?dir=in`)).status).toBe(401);
  });
});
