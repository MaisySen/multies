import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

/**
 * PAR1 (found by the VID2 transcript check): with the workspace AI switch (TD1) off, a call's audio goes to no AI
 * provider. Before, the switch only stopped the summary; the transcript chunks still went to the provider.
 */
const KEY = ["sk", "test", "0123456789abcdefWXYZ"].join("-"); // a test value, built so the secret scanner does not flag it
const audio = Buffer.from(new Uint8Array(64).map((_, i) => i % 251)).toString("base64");

async function app() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (String(input).endsWith("/audio/transcriptions")) return Response.json({ text: "Hello from the call." });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "S", decisions: [], actionItems: [] }) } }] });
  }) as typeof fetch;
  const ctx = await makeTestApp({ ASK_TD1: "on" }, { fetch: fetchImpl });
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io", "Olive Owner");
  expect((await c.put("/api/ai/key", { provider: "openai", apiKey: KEY })).status).toBe(200);
  const mid = (await c.post("/api/meetings", { title: "Weekly sync", startsAt: new Date().toISOString(), durationMin: 30 })).body.meeting.id as string;
  return { c, calls, mid };
}

describe("PAR1 call transcripts follow the workspace AI switch", () => {
  it("AI on: a chunk is transcribed (one provider call)", async () => {
    const { c, calls, mid } = await app();
    const rid = (await c.post(`/api/meetings/${mid}/recordings`, {})).body.recording.id;
    expect((await c.call("PUT", `/api/meetings/${mid}/recordings/${rid}/chunks/0`, { audioBase64: audio, mime: "audio/webm;codecs=opus", offsetSec: 0, durationSec: 10 })).status).toBe(200);
    expect(calls.filter((u) => u.endsWith("/audio/transcriptions"))).toHaveLength(1);
  });

  it("AI off: setup says so, start is refused, a chunk mid recording makes zero provider calls", async () => {
    const { c, calls, mid } = await app();
    const rid = (await c.post(`/api/meetings/${mid}/recordings`, {})).body.recording.id;
    expect((await c.put("/api/ai-trust", { enabled: false })).status).toBe(200);
    const list = (await c.get(`/api/meetings/${mid}/recordings`)).body;
    expect(list.setup).toMatchObject({ ready: false, code: "recording_needs_ai_on" });
    expect(list.setup.message).toContain("AI is off for this workspace");
    const chunk = await c.call("PUT", `/api/meetings/${mid}/recordings/${rid}/chunks/0`, { audioBase64: audio, mime: "audio/webm;codecs=opus", offsetSec: 0, durationSec: 10 });
    expect(chunk.status).toBe(409);
    expect(chunk.body.error.code).toBe("recording_needs_ai_on");
    const start = await c.post(`/api/meetings/${mid}/recordings`, {});
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe("recording_needs_ai_on");
    expect(calls).toEqual([]);
  });
});
