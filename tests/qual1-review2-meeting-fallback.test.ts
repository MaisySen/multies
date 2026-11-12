/**
 * QUAL1 second review of PR 20: with AI_KEY_FALLBACK=on, when the provider refuses the workspace's key during "Suggest", built-in AI
 * writes the meeting's action items but POST /api/meeting-td3/:id/suggest drops the `fallback` note that ask() returns
 * (services/suite/meeting-suggestions-td3.ts). The page (meeting-suggest-td3.tsx doSuggest) only re-reads the gate
 * after an error, so the first stand-in answer is shown as if the workspace's own provider wrote it.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { meetingRecordings } from "@/server/db/schema";

const KEY = "sk-ant-api03-" + "b".repeat(40) + "WXYZ";

describe("QUAL1 second review: the meeting suggestions say when built-in AI wrote them", () => {
  it("a refused key with the stand-in on: the answer carries fallback", async () => {
    const ctx = await makeTestApp({ MEET_TD3: "on", AI_CONNECT_AI2: "on", AI_KEY_FALLBACK: "on" });
    let refused = false;
    ctx.deps.fetch = (async (input: RequestInfo | URL) => {
      if (refused) return new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401 });
      if (String(input).includes("/v1/models")) return Response.json({ data: [{ id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" }] });
      return Response.json({ content: [{ type: "text", text: "OK" }] });
    }) as unknown as typeof fetch;
    const answer = JSON.stringify({ actionItems: [{ text: "Write the launch email", owner: null, due: null, quote: "I will write the launch email by Thursday." }] });
    const builtin = vi.fn(async () => ({ response: answer, usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    ctx.deps.ai = { run: builtin } as never;
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    expect((await c.post("/api/ai/connect", { apiKey: KEY })).status).toBe(200);
    refused = true;
    const m = (await c.post("/api/meetings", { title: "Launch sync", startsAt: "2026-10-26T03:00:00.000Z", durationMin: 30, invitees: [] })).body.meeting as { id: string };
    const me = (await c.get("/api/account/me")).body;
    const now = new Date("2026-10-26T03:30:00.000Z");
    await ctx.db.insert(meetingRecordings).values({ orgId: me.organization.id, meetingId: m.id, id: "rec_1", startedBy: me.user.id, status: "done", startedAt: now, endedAt: now, durationSec: 600, chunkCount: 1, transcript: "[01:02] Olive: I will write the launch email by Thursday.", summary: null, actionItems: "[]", updatedAt: now } as never);
    expect((await c.get(`/api/meeting-td3/${m.id}`)).body.ai).toMatchObject({ state: "ready", message: null });

    const r = await c.post(`/api/meeting-td3/${m.id}/suggest`, { source: "recording", recordingId: "rec_1" });
    expect(r.status).toBe(200);
    expect(builtin).toHaveBeenCalled();
    expect(r.body.added).toBe(1);
    expect(r.body.fallback, "built-in AI wrote these suggestions; the answer must say so, as the mail assistant, Tools and forms do").toMatchObject({ reason: "key_refused" });
  });
});
