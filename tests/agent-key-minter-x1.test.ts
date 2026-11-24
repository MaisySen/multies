/**
 * Wave 2 review X1: an agent key keeps a personal mailbox only when the person who minted it (in their own app session)
 * owns that mailbox. Before, the key was checked only at mint time, so a key minted by another admin or by a workspace
 * key reached the maker's personal inbox once she attached it to the agent later. Migration 0179 records who minted each
 * key where the audit log proves it, and takes personal mailboxes off agents a key made before Wave 1 review V2.
 */
import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { privacyWorld } from "./priv1a-world";
import { agentMailboxAccess, agents, apiKeys, auditLogs } from "@/server/db/schema";
import { MIGRATIONS } from "@/server/db/migrations.generated";
import { newId } from "@/server/lib/crypto";

type W = Awaited<ReturnType<typeof privacyWorld>>;

async function v1(w: W, key: string, method: string, path: string, body?: unknown) {
  const res = await w.ctx.app.request(`/api/v1${path}`, {
    method, headers: { authorization: `Bearer ${key}`, host: "localhost", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const wsKey = async (c: W["admin"]["c"]) => (await c.post("/api/developer/keys", { name: "ws" })).body.secret as string;

/** Pat (an admin) makes an agent on the team mailbox only; keys are minted for it; then she adds her personal inbox. */
async function setup() {
  const w = await privacyWorld();
  expect((await w.owner.patch(`/api/team/members/${w.pat.id}`, { role: "admin" })).status).toBe(200);
  const made = await w.pat.c.post("/api/agents", { name: "Pat helper", localPart: `pathelper${w.n}`, mailboxIds: [w.boxes.team], allowedRecipients: null });
  expect(made.status).toBe(201);
  const id = made.body.agent.id as string;
  const own = made.body.apiKey.secret as string;
  // Ada (another admin) mints a key in the app while the agent has no personal mailbox: allowed.
  const ada = await w.admin.c.post(`/api/agents/${id}/keys`, { name: "Ada's" });
  expect(ada.status).toBe(201);
  // And a key minted by Pat's own workspace key: no person session behind it.
  const patWs = await wsKey(w.pat.c);
  const viaKey = await v1(w, patWs, "POST", `/agents/${id}/keys`, { name: "via ws key" });
  expect(viaKey.status).toBe(201);
  expect((await w.pat.c.patch(`/api/agents/${id}`, { mailboxIds: [w.boxes.team, w.boxes.personal] })).status).toBe(200);
  return { w, id, own, adaKey: ada.body.secret as string, viaKey: viaKey.body.secret as string };
}

describe("X1: an agent key reaches a personal mailbox only when its minter owns it", () => {
  it("keys minted by another admin or by a workspace key don't read the maker's personal inbox added later; hers does", async () => {
    const { w, id, own, adaKey, viaKey } = await setup();
    const thread = `/threads/thr_pers${w.n}aaaaaaaaaa`;
    expect((await v1(w, own, "GET", thread)).status).toBe(200);
    expect((await v1(w, adaKey, "GET", thread)).status).toBe(404);
    expect((await v1(w, viaKey, "GET", thread)).status).toBe(404);
    expect(JSON.stringify((await v1(w, adaKey, "GET", `/agents/${id}/threads?limit=50`)).body)).not.toContain(`SUBJECT-PERS-${w.n}`);
    expect(JSON.stringify((await v1(w, own, "GET", `/agents/${id}/threads?limit=50`)).body)).toContain(`SUBJECT-PERS-${w.n}`);
    // Team mail still works for every key.
    expect((await v1(w, adaKey, "GET", `/threads/thr_team${w.n}aaaaaaaaaa`)).status).toBe(200);
    // Sending from the personal mailbox: refused for Ada's key, as for any mailbox the agent may not use.
    const send = await v1(w, adaKey, "POST", `/agents/${id}/send`, { mailboxId: w.boxes.personal, to: [`max${w.n}@acme.io`], subject: "Not Ada's", text: "x" });
    expect(send.status).toBe(403);
    expect(send.body.error.code).toBe("mailbox_not_allowed");
  }, 120_000);

  it("records who minted each key: a person in the app, never a workspace key", async () => {
    const { w, id } = await setup();
    const keys = await w.ctx.db.select({ name: apiKeys.name, minted: apiKeys.mintedByUserId }).from(apiKeys).where(eq(apiKeys.agentId, id));
    const by = Object.fromEntries(keys.map((k) => [k.name, k.minted]));
    expect(by["Pat helper agent key"]).toBe(w.pat.id);
    expect(by["Ada's"]).toBe(w.admin.id);
    expect(by["via ws key"]).toBeNull();
  }, 120_000);
});

describe("X1 migration 0179", () => {
  it("backfills the minter only where the agent.created audit proves a person session, and strips agents a key made", async () => {
    const { w, id } = await setup();
    // Keys as they were before the column: nobody recorded.
    await w.ctx.db.run(sql`update api_keys set minted_by_user_id = null where agent_id = ${id}`);
    // An agent a workspace key made before Wave 1 review V2: it kept the key's maker as its maker, and holds her inbox.
    const old = newId("agt");
    const src = (await w.ctx.db.select().from(agents).where(eq(agents.id, id)).get())!;
    const other = (await w.owner.post("/api/mailboxes", { domainId: w.domainId, localPart: `oldbot${w.n}`, displayName: "Old bot" })).body.mailbox.id as string;
    await w.ctx.db.insert(agents).values({ ...src, id: old, mailboxId: other, name: "Old bot", createdByUserId: w.pat.id });
    await w.ctx.db.insert(agentMailboxAccess).values([{ agentId: old, mailboxId: w.boxes.personal, orgId: w.orgId }, { agentId: old, mailboxId: w.boxes.team, orgId: w.orgId }]);
    await w.ctx.db.insert(auditLogs).values({ id: newId("aud"), orgId: w.orgId, actorUserId: w.pat.id, actorEmail: "api-key:mm_live_abcd", action: "agent.created", targetType: "agent", targetId: old, agentId: old, metadata: JSON.stringify({ via: "api" }) });

    const m = MIGRATIONS.find((x) => x.name.startsWith("0179_"))!;
    for (const st of m.statements.filter((s) => !/ALTER TABLE/i.test(s))) await w.ctx.db.run(sql.raw(st));
    // Idempotent.
    for (const st of m.statements.filter((s) => !/ALTER TABLE/i.test(s))) await w.ctx.db.run(sql.raw(st));

    const keys = await w.ctx.db.select({ name: apiKeys.name, minted: apiKeys.mintedByUserId }).from(apiKeys).where(eq(apiKeys.agentId, id));
    const by = Object.fromEntries(keys.map((k) => [k.name, k.minted]));
    // The key minted with the agent by Pat in the app (agent.created via "app"): proven.
    expect(by["Pat helper agent key"]).toBe(w.pat.id);
    // Keys minted later: the audit row can't tell a person session from a connected AI app, so they stay unproven.
    expect(by["Ada's"]).toBeNull();
    expect(by["via ws key"]).toBeNull();

    const oldRow = (await w.ctx.db.select().from(agents).where(eq(agents.id, old)).get())!;
    expect(oldRow.createdByUserId).toBeNull();
    const held = await w.ctx.db.select({ m: agentMailboxAccess.mailboxId }).from(agentMailboxAccess).where(eq(agentMailboxAccess.agentId, old));
    expect(held.map((r) => r.m)).toEqual([w.boxes.team]);
    // Pat's own agent (made in the app) keeps her as its maker and her inbox.
    expect((await w.ctx.db.select().from(agents).where(eq(agents.id, id)).get())!.createdByUserId).toBe(w.pat.id);
    expect((await w.ctx.db.select({ m: agentMailboxAccess.mailboxId }).from(agentMailboxAccess).where(eq(agentMailboxAccess.agentId, id))).map((r) => r.m)).toContain(w.boxes.personal);
  }, 120_000);
});
