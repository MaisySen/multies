import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { makeTestApp, Client } from "./helpers";
import { mockInboundPayload } from "@/server/services/channels/mock";
import { handleWebhookPost } from "@/server/services/channels/receive";
import { parseWebhook, verifySignature, MOCK_APP_SECRET } from "@/server/services/channels/webhook";
import { msgChannels } from "@/server/db/schema";
import { eq } from "drizzle-orm";

/**
 * C1: what one inbound chat message costs. Counts the statements the ingest runs (writes and reads) so a change
 * that adds a write per message fails here, and times the handler on this machine as a CPU guide for the
 * Workers 10 ms limit (SQLite runs in process here, so the figure is an upper bound: on D1 the query runs remotely).
 */
function spy(db: unknown) {
  const client = (db as { $client: { prepare: (sql: string) => unknown } }).$client;
  const prepare = client.prepare.bind(client);
  const log: string[] = [];
  client.prepare = (sql: string) => { log.push(sql); return prepare(sql); };
  return log;
}

describe("channels ingest cost", () => {
  it("one new text message: 3 writes and 2 reads; a duplicate: 1 read and no write", async () => {
    const ctx = await makeTestApp({ CHANNELS_MOCK: "on" });
    const owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
    await owner.put("/api/channels/settings", { enabled: true });
    const channelId = (await owner.post("/api/channels/connect-mock", {})).body.channel.id;
    const ch = await ctx.db.select().from(msgChannels).where(eq(msgChannels.id, channelId)).get();
    // Warm: the first message makes the conversation; measure the steady state (an existing conversation) and the first.
    const first = await mockInboundPayload({ endpointId: ch!.externalId, from: "61400111222", text: "first" });
    const log = spy(ctx.db);
    await (await handleWebhookPost(ctx.deps, first.body, first.signature)).work;
    const firstSql = [...log];
    log.length = 0;
    const next = await mockInboundPayload({ endpointId: ch!.externalId, from: "61400111222", text: "second" });
    await (await handleWebhookPost(ctx.deps, next.body, next.signature)).work;
    const steady = [...log];
    log.length = 0;
    await (await handleWebhookPost(ctx.deps, next.body, next.signature)).work;
    const dup = [...log];
    const isWrite = (s: string) => /^\s*(insert|update|delete)/i.test(s);
    expect(firstSql.filter(isWrite)).toHaveLength(3);
    expect(steady.filter(isWrite)).toHaveLength(3);
    expect(steady.filter((s) => !isWrite(s))).toHaveLength(2);
    expect(dup.filter(isWrite)).toHaveLength(0);
    mkdirSync(".data", { recursive: true });
    writeFileSync(".data/c1-ingest-sql.json", JSON.stringify({ steady, dup }, null, 2));

    // CPU guide: signature check, parse and the full ingest path per message, median of 200 on this machine.
    const times: number[] = [];
    const pure: number[] = [];
    for (let i = 0; i < 200; i++) {
      const p = await mockInboundPayload({ endpointId: ch!.externalId, from: `614001${String(i).padStart(5, "0")}`, text: `hello number ${i}` });
      const t0 = performance.now();
      await verifySignature(p.body, p.signature, [MOCK_APP_SECRET]);
      parseWebhook(JSON.parse(p.body));
      pure.push(performance.now() - t0);
      const t1 = performance.now();
      await (await handleWebhookPost(ctx.deps, p.body, p.signature)).work;
      times.push(performance.now() - t1);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
    const result = { verifyAndParseMedianMs: +med(pure).toFixed(3), fullIngestMedianMs: +med(times).toFixed(3), fullIngestP95Ms: +p95(times).toFixed(3) };
    writeFileSync(".data/c1-ingest-cpu.json", JSON.stringify(result));
    console.log("C1 ingest timing", result);
    expect(result.verifyAndParseMedianMs).toBeLessThan(5);
  });
});
