/**
 * QUAL1 review (defect 5, audit row 14, brief part b: "every place that shows the key's state ... shows the real
 * state"): the call recording setup (services/suite/meeting-recordings.ts recordingSetup, read by the meeting room
 * before Record) ignored the key's noted refusal and answered ready with no message, so the recorder started and
 * every chunk failed on a key already known to be refused. Now it stays ready (a call that works clears the note, so
 * blocking Record would keep a fixed key stuck) and carries the plain sentence, which the room shows with the fix link.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

const KEY = "sk-test-0123456789abcdefWXYZ";

describe("the recording setup shows a refused key (QUAL1 review)", () => {
  it("a key noted as refused is not 'ready' with no message", async () => {
    let refused = false;
    let providerCalls = 0;
    const ctx = await makeTestApp({}, {
      fetch: (async (input: RequestInfo | URL) => {
        providerCalls++;
        if (refused) return new Response('{"error":{"message":"Incorrect API key provided"}}', { status: 401 });
        return String(input).endsWith("/audio/transcriptions") ? Response.json({ text: "Hello." }) : Response.json({ choices: [{ message: { content: "OK" } }] });
      }) as typeof fetch,
    });
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io", "Olive Owner");
    expect((await c.put("/api/ai/key", { provider: "openai", apiKey: KEY })).status).toBeLessThan(300);
    const g = ((await c.get("/api/chat/channels")).body.channels as { id: string; name: string }[]).find((x) => x.name === "general")!;
    const meetingId = (await c.post(`/api/chat/channels/${g.id}/call`, {})).body.meeting.id as string;
    const rid = (await c.post(`/api/meetings/${meetingId}/recordings`, {})).body.recording.id as string;
    refused = true;
    const chunk = await c.call("PUT", `/api/meetings/${meetingId}/recordings/${rid}/chunks/0`, { audioBase64: Buffer.from(new Uint8Array(64)).toString("base64"), mime: "audio/webm;codecs=opus", offsetSec: 0, durationSec: 300 });
    // Round 2 (PR 20, changed on purpose): 409 ai_key_refused, as every other AI route (was 502).
    expect(chunk.status).toBe(409);
    expect(chunk.body.error.code).toBe("ai_key_refused");
    expect((await c.get("/api/ai/status")).body.problem).toBe("key_refused");
    expect(providerCalls).toBeGreaterThan(0);

    const setup = (await c.get(`/api/meetings/${meetingId}/recordings`)).body.setup;
    expect(setup).toMatchObject({ ready: true, keyProblem: "key_refused", message: "OpenAI refused your workspace's AI key. An admin can paste a new key in Settings, AI.", canConfigure: true });
    // A chunk that works clears the note, and the setup is plain ready again.
    refused = false;
    expect((await c.call("PUT", `/api/meetings/${meetingId}/recordings/${rid}/chunks/0`, { audioBase64: Buffer.from(new Uint8Array(64)).toString("base64"), mime: "audio/webm;codecs=opus", offsetSec: 0, durationSec: 300 })).status).toBe(200);
    const after = (await c.get(`/api/meetings/${meetingId}/recordings`)).body.setup;
    expect(after).toMatchObject({ ready: true, message: null });
    expect(after.keyProblem).toBeUndefined();
  });

  it("the meeting room shows the sentence with the fix link, and warns when Record is pressed", async () => {
    const { readFileSync } = await import("node:fs");
    const room = readFileSync("src/web/pages/app/work/meeting-recording.tsx", "utf8");
    expect(room).toContain('data-testid="record-key-problem"');
    expect(room).toContain("if (setup?.keyProblem && setup.message) toast.warning(setup.message);");
  });
});
