/**
 * W4 (e2e workload-r24): opening an invite link again after it has made you a member opens the workspace (200)
 * instead of "already used" (410). Someone who is not a member still gets 410.
 */
import { describe, expect, it } from "vitest";
import { Client, makeTestApp } from "./helpers";

describe("W4: accepting an invite that already made you a member", () => {
  it("answers 200 with the workspace for a member, and 410 for anyone else", async () => {
    const ctx = await makeTestApp();
    const owner = new Client(ctx.app);
    await owner.signup("owner@acme.io");
    const inv = await owner.post("/api/team/invites", { email: "maya@acme.io", role: "member" });
    expect(inv.status).toBe(201);
    const id = inv.body.link.split("/invite/")[1];

    const maya = new Client(ctx.app);
    await maya.signup("maya@acme.io", "Maya", "");
    const first = await maya.post(`/api/invites/${id}/accept`);
    expect([200, 410]).toContain(first.status); // sign up may already have joined through the pending invite
    const again = await maya.post(`/api/invites/${id}/accept`);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.orgName).toBe("Acme");
    expect(again.body.role).toBe("member");
    // The workspace is the one open in Maya's session.
    expect((await maya.get("/api/account/me")).body.organization?.name ?? (await maya.get("/api/account/me")).body.org?.name).toBe("Acme");

    const stranger = new Client(ctx.app);
    await stranger.signup("stranger@else.io", "Stranger", "Else");
    const used = await stranger.post(`/api/invites/${id}/accept`);
    expect(used.status).toBe(410);
    expect(used.body.error?.code ?? used.body.code).toBe("invite_used");
  });
});
