import { describe, expect, it } from "vitest";
import { mboxBatches, splitMbox, toBase64, unquoteFrom } from "../src/web/lib/mbox-r40";
import { makeTestApp, Client } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("R40 mbox parser (browser)", () => {
  it("splits on From_ lines and drops the separator", () => {
    const f = "From a@x Mon Jan  1 00:00:00 2024\nSubject: one\n\nhello\n\nFrom b@x Tue Jan  2 00:00:00 2024\nSubject: two\n\nworld\n";
    const m = splitMbox(enc(f));
    expect(m.map(dec)).toEqual(["Subject: one\n\nhello\n", "Subject: two\n\nworld\n"]);
  });
  it("does not split on a From line inside a paragraph", () => {
    const f = "From a@x Mon\nSubject: one\n\nhello\nFrom here on we talk\n";
    expect(splitMbox(enc(f))).toHaveLength(1);
  });
  it("unquotes >From and >>From lines (one > each)", () => {
    const f = "From a@x Mon\nSubject: q\n\n>From the start\n>>From deeper\n> not this\n";
    expect(dec(splitMbox(enc(f))[0])).toBe("Subject: q\n\nFrom the start\n>From deeper\n> not this\n");
    expect(dec(unquoteFrom(enc(">From x")))).toBe("From x");
  });
  it("handles CRLF files", () => {
    const f = "From a@x Mon\r\nSubject: one\r\n\r\nhi\r\n\r\nFrom b@x Tue\r\nSubject: two\r\n\r\nyo\r\n";
    const m = splitMbox(enc(f));
    expect(m.map(dec)).toEqual(["Subject: one\r\n\r\nhi\r\n", "Subject: two\r\n\r\nyo\r\n"]);
  });
  it("an empty file has no messages", () => {
    expect(splitMbox(new Uint8Array())).toEqual([]);
    expect(splitMbox(enc("just some text"))).toEqual([]);
  });
  it("a file with one message", () => {
    const m = splitMbox(enc("From a@x Mon\nMessage-ID: <1@x>\nSubject: solo\n\nbody"));
    expect(m).toHaveLength(1);
    expect(dec(m[0])).toContain("Subject: solo");
  });
  it("keeps 8 bit bytes exactly and round trips through base64", () => {
    const body = new Uint8Array([...enc("From a@x Mon\nSubject: b\n\n"), 0xe9, 0x80, 0xff, 0x0a]);
    const m = splitMbox(body)[0];
    expect(Array.from(m.slice(-4))).toEqual([0xe9, 0x80, 0xff, 0x0a]);
    const back = Uint8Array.from(atob(toBase64(m)), (c) => c.charCodeAt(0));
    expect(Array.from(back)).toEqual(Array.from(m));
  });
  it("batches by count and by bytes", () => {
    const small = Array.from({ length: 25 }, () => new Uint8Array(10));
    expect(mboxBatches(small, 10).map((b) => b.length)).toEqual([10, 10, 5]);
    const big = [new Uint8Array(400), new Uint8Array(400), new Uint8Array(10)];
    expect(mboxBatches(big, 10, 500).map((b) => b.length)).toEqual([1, 2]);
  });
});


const rawMsg = (id: string, subject: string, extra = "") =>
  `Message-ID: <${id}@old.example>\r\nFrom: Old Friend <friend@old.example>\r\nTo: me@acme.io\r\nSubject: ${subject}\r\n${extra}Date: Tue, 1 Sep 2026 09:00:00 +1000\r\nContent-Type: text/plain\r\n\r\nHello from the archive.\r\n`;

async function mboxSetup() {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
  const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
  return { ctx, c, box };
}

describe("R40 mbox upload (server batches)", () => {
  it("stores a batch, threads the reply, and a repeat batch adds nothing", async () => {
    const { c, box } = await mboxSetup();
    const file = new TextEncoder().encode(
      `From a@x Mon Sep  1 09:00:00 2026\r\n${rawMsg("m1", "Archive one")}\r\nFrom b@x Mon Sep  1 09:05:00 2026\r\n${rawMsg("m2", "Re: Archive one", "In-Reply-To: <m1@old.example>\r\n")}`);
    const msgs = splitMbox(file);
    expect(msgs).toHaveLength(2);
    const body = { mailboxId: box.id, total: 2, fileName: "old.mbox", last: true, messages: msgs.map(toBase64) };
    const first = await c.call("POST", "/api/data-moves/mbox/batch", body, { "idempotency-key": "mbox_batch_0001aa" });
    expect(first.status).toBe(200);
    expect(first.body.counts).toEqual({ stored: 2, duplicates: 0, unreadable: 0 });
    expect(first.body.move).toMatchObject({ status: "done", source: "mail:mbox", done: 2, total: 2, canUndo: true });
    // The same key answers the same result without storing again.
    const retry = await c.call("POST", "/api/data-moves/mbox/batch", body, { "idempotency-key": "mbox_batch_0001aa" });
    expect(retry.body.counts).toEqual(first.body.counts);
    // A fresh run with the same messages finds them already there.
    const again = await c.call("POST", "/api/data-moves/mbox/batch", body, { "idempotency-key": "mbox_batch_0002bb" });
    expect(again.body.counts).toEqual({ stored: 0, duplicates: 2, unreadable: 0 });
    const inbox = (await c.get(`/api/mail/messages?mailboxId=${box.id}&folder=inbox`)).body.messages as { subject: string; threadId?: string }[];
    expect(inbox.map((m) => m.subject).sort()).toEqual(["Archive one", "Re: Archive one"]);
    const history = (await c.get("/api/data-moves")).body.items;
    expect(history[0]).toMatchObject({ source: "mail:mbox", fileName: "old.mbox" });
  });

  it("carries one run across batches, refuses big batches, and stops on Cancel", async () => {
    const { c, box } = await mboxSetup();
    const b1 = await c.post("/api/data-moves/mbox/batch", { mailboxId: box.id, total: 3, messages: [toBase64(new TextEncoder().encode(rawMsg("x1", "One")))] });
    expect(b1.body.move.status).toBe("running");
    const id = b1.body.move.id;
    const b2 = await c.post("/api/data-moves/mbox/batch", { mailboxId: box.id, moveId: id, total: 3, messages: [toBase64(new TextEncoder().encode(rawMsg("x2", "Two"))), toBase64(new TextEncoder().encode("not mail at all"))] });
    expect(b2.body.move.done).toBe(3);
    expect(b2.body.counts.stored + b2.body.counts.unreadable).toBe(3);
    const tooMany = await c.post("/api/data-moves/mbox/batch", { mailboxId: box.id, moveId: id, total: 3, messages: Array.from({ length: 11 }, () => "eA==") });
    expect(tooMany.status).toBe(422);
    const stop = await c.post(`/api/data-moves/mbox/${id}/stop`, {});
    expect(stop.body.move.status).toBe("stopped");
    expect((await c.post("/api/data-moves/mbox/batch", { mailboxId: box.id, moveId: id, total: 3, messages: [] })).status).toBe(409);
  });

  it("is for owners and admins, in their own workspace", async () => {
    const { ctx, box } = await mboxSetup();
    const other = new Client(ctx.app);
    await other.signup("someone@else.io");
    const r = await other.post("/api/data-moves/mbox/batch", { mailboxId: box.id, total: 1, messages: [] });
    expect(r.status).toBe(404);
  });
});
