/**
 * Wave 1 review V1 (high): a workspace export started with a workspace key stored the key's maker as the starter, and
 * the download rebuilt the maker's auth, so the ZIP carried the maker's personal mailboxes (and, for an owner, the
 * orphaned ones). An export a key starts now runs with no person behind it: team mailboxes only. A person's export is
 * unchanged.
 */
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { privacyWorld } from "./priv1a-world";

describe("Wave 1 review V1: a key's export carries no personal mailbox", () => {
  it("v1 POST /data-moves/exports by the owner of a personal mailbox leaves it out; her own export keeps it", async () => {
    const w = await privacyWorld();
    const { ctx, n } = w;
    expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { role: "admin" })).status).toBe(200);
    const key = (await w.pat.c.post("/api/developer/keys", { name: "export" })).body.secret as string;
    const started = await ctx.app.request("/api/v1/data-moves/exports", { method: "POST", headers: { authorization: `Bearer ${key}`, host: "localhost", "content-type": "application/json" }, body: "{}" });
    expect(started.status).toBeLessThan(300);
    const url = new URL(((await started.json()) as { downloadUrl: string }).downloadUrl);
    const dl = await ctx.app.request(`${url.pathname}${url.search}`, { headers: { host: "localhost" } });
    expect(dl.status).toBe(200);
    const files = unzipSync(new Uint8Array(await dl.arrayBuffer()));
    const all = Object.entries(files).map(([name, b]) => `${name}\n${strFromU8(b)}`).join("\n");
    expect(all).not.toContain(`pat.private${n}@acme.io`);
    expect(all).not.toContain(`SUBJECT-PERS-${n}`);
    expect(all).toContain(`SUBJECT-TEAM-${n}`);

    // Pat's own export in the app still has her personal mailbox (ten minutes later: one export every 10 minutes).
    const later = Date.now() + 11 * 60_000;
    ctx.deps.now = () => new Date(later);
    const mine = await w.pat.c.post("/api/data-moves/exports", {});
    expect(mine.status).toBeLessThan(300);
    const md = await ctx.app.request(mine.body.downloadPath, { headers: { host: "localhost" } });
    const mfiles = unzipSync(new Uint8Array(await md.arrayBuffer()));
    expect(Object.entries(mfiles).map(([name, b]) => `${name}\n${strFromU8(b)}`).join("\n")).toContain(`SUBJECT-PERS-${n}`);
  }, 120_000);
});
