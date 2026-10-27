import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { SESSION_MS } from "@/server/services/suite/doc-versions-r39";

/**
 * R40: page history with two people on one doc. One restores a version while the other saves: no version is lost,
 * the restore keeps the page before it as a version, and a save made from a stale read gets the 409 conflict answer
 * (code version_conflict, details.currentVersion) instead of overwriting the restore.
 */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
let owner: Client;
let mate: Client;
let clock = Date.parse("2026-11-02T09:00:00.000Z");
const tick = (ms: number) => { clock += ms; };
type V = { id: string; name: string | null; reason?: string; docVersion: number };

async function texts(c: Client, docId: string) {
  const list = (await c.get(`/api/docs/${docId}/versions?limit=200`)).body.versions as V[];
  const out: string[] = [];
  for (const v of list) out.push((await c.get(`/api/docs/${docId}/versions/${v.id}`)).body.version.text as string);
  return { list, texts: out };
}

beforeEach(async () => {
  clock = Date.parse("2026-11-02T09:00:00.000Z");
  ctx = await makeTestApp();
  ctx.deps.now = () => new Date(clock);
  owner = new Client(ctx.app);
  await owner.signup("owner@restore.test");
  const invite = await owner.post("/api/team/invites", { email: "mate@restore.test", role: "member" });
  mate = new Client(ctx.app);
  await mate.signup("mate@restore.test", "Mate", "");
  expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
});

describe("R40 doc restore with two people", () => {
  it("a restore keeps the page before it, and a stale save from the other person gets the conflict answer", async () => {
    const doc = (await owner.post("/api/docs", { title: "Launch plan", text: "Draft one" })).body.doc;
    const named = await owner.post(`/api/docs/${doc.id}/versions`, { name: "First draft" });
    expect(named.status).toBe(201);
    tick(SESSION_MS + 1000);
    // The teammate writes the second draft.
    const read1 = (await mate.get(`/api/docs/${doc.id}`)).body.doc;
    const v2 = await mate.patch(`/api/docs/${doc.id}`, { text: "Draft two by Mate", version: read1.version });
    expect(v2.status).toBe(200);

    // Both now hold the same version. The owner restores the first draft while Mate is still typing.
    const ownerRead = (await owner.get(`/api/docs/${doc.id}`)).body.doc;
    const mateRead = (await mate.get(`/api/docs/${doc.id}`)).body.doc;
    expect(ownerRead.version).toBe(mateRead.version);
    tick(60_000);
    const restored = await owner.post(`/api/docs/${doc.id}/versions/${named.body.version.id}/restore`, { ifVersion: ownerRead.version });
    expect(restored.status).toBe(200);
    expect(restored.body.doc.version).toBe(ownerRead.version + 1);
    expect(restored.body.savedCurrentAs).toBeTruthy();

    // Mate saves from the read made before the restore: refused, with the version to reload.
    tick(5_000);
    const stale = await mate.patch(`/api/docs/${doc.id}`, { text: "Draft three by Mate", version: mateRead.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("version_conflict");
    expect(stale.body.error.details.currentVersion).toBe(ownerRead.version + 1);
    expect((await owner.get(`/api/docs/${doc.id}`)).body.doc.text).toContain("Draft one");

    // After reloading, Mate's save goes in on top of the restore.
    const reread = (await mate.get(`/api/docs/${doc.id}`)).body.doc;
    tick(SESSION_MS + 1000);
    expect((await mate.patch(`/api/docs/${doc.id}`, { text: "Draft three by Mate", version: reread.version })).status).toBe(200);

    // No page state was lost: the named draft, Mate's second draft (kept by the restore) and the restored page.
    const h = await texts(owner, doc.id);
    expect(h.texts.some((t) => t.includes("Draft one"))).toBe(true);
    expect(h.texts.some((t) => t.includes("Draft two by Mate"))).toBe(true);
    expect(h.list.some((v) => v.name === "First draft")).toBe(true);
    // The restore can itself be undone: the version it saved holds Mate's second draft.
    const back = h.list.find((v) => v.id === restored.body.savedCurrentAs)!;
    expect((await owner.get(`/api/docs/${doc.id}/versions/${back.id}`)).body.version.text).toContain("Draft two by Mate");
  });

  it("a restore and a save sent at the same moment: exactly one wins, the other gets 409, nothing is lost", async () => {
    const doc = (await owner.post("/api/docs", { title: "Race", text: "Alpha" })).body.doc;
    const named = await owner.post(`/api/docs/${doc.id}/versions`, { name: "Alpha" });
    tick(SESSION_MS + 1000);
    const r = (await owner.get(`/api/docs/${doc.id}`)).body.doc;
    expect((await owner.patch(`/api/docs/${doc.id}`, { text: "Beta", version: r.version })).status).toBe(200);
    const at = (await owner.get(`/api/docs/${doc.id}`)).body.doc.version;
    tick(SESSION_MS + 1000);
    const [restore, save] = await Promise.all([
      owner.post(`/api/docs/${doc.id}/versions/${named.body.version.id}/restore`, { ifVersion: at }),
      mate.patch(`/api/docs/${doc.id}`, { text: "Gamma by Mate", version: at }),
    ]);
    const statuses = [restore.status, save.status].sort();
    expect(statuses).toEqual([200, 409]);
    const now = (await owner.get(`/api/docs/${doc.id}`)).body.doc;
    expect(now.version).toBe(at + 1);
    expect(now.text).toContain(restore.status === 200 ? "Alpha" : "Gamma by Mate");
    // Beta, the page both started from, is kept as a version whichever one won.
    const h = await texts(owner, doc.id);
    expect(h.texts.some((t) => t.includes("Beta"))).toBe(true);
    expect(h.texts.some((t) => t.includes("Alpha"))).toBe(true);
  });
});
