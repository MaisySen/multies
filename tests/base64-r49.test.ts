import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toBase64, splitMbox } from "../src/web/lib/mbox-r40";
import { dataMoves, messages } from "../src/server/db/schema";
import { fromB64Or, toB64, tryFromB64 } from "../src/server/lib/crypto";
import { HttpError } from "../src/server/lib/errors";
import { b64urlDecode } from "../src/server/lib/web-push";
import { base64Bytes, ImportFileError } from "../src/server/services/work-import/parse";
import { MBOX_UNREADABLE } from "../src/server/services/data-move/mbox";
import { makeTestApp, Client } from "./helpers";

const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);

describe("R49 tryFromB64 (MYMAIL-API-15)", () => {
  it("reads plain base64, base64url, missing padding, whitespace and line breaks", () => {
    const b64 = toB64(bytes);
    const url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(Array.from(tryFromB64(b64)!)).toEqual(Array.from(bytes));
    expect(Array.from(tryFromB64(url)!)).toEqual(Array.from(bytes));
    expect(Array.from(tryFromB64(`  ${b64.slice(0, 4)}\r\n${b64.slice(4)}\n`)!)).toEqual(Array.from(bytes));
    expect(Array.from(tryFromB64("")!)).toEqual([]);
  });
  it("answers null for anything that is not base64, never throws", () => {
    for (const bad of ["not base64!", "abc%", "a", "abcde", "====a", "ä", "<html>", null, undefined, 42, {}]) expect(tryFromB64(bad)).toBeNull();
  });
  it("fromB64Or throws the given 4xx error", () => {
    expect(() => fromB64Or("%%%", () => new HttpError(422, "validation_failed", "nope"))).toThrow(HttpError);
    expect(Array.from(fromB64Or(toB64(bytes), () => new Error("x")))).toEqual(Array.from(bytes));
  });
  it("the work import and web push decoders use it", () => {
    expect(() => base64Bytes("not base64!")).toThrow(ImportFileError);
    expect(Array.from(base64Bytes(toB64(bytes)))).toEqual(Array.from(bytes));
    expect(() => b64urlDecode("%%%")).toThrow("not base64url");
  });
});

describe("R49 mail archive import with a body that is not base64", () => {
  it("answers 422 with a plain message and writes nothing", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id;
    const box = (await c.post("/api/mailboxes", { domainId, localPart: "me", displayName: "Me" })).body.mailbox;
    const good = splitMbox(new TextEncoder().encode("From a@x Mon Sep  1 09:00:00 2026\r\nMessage-ID: <g1@old.example>\r\nSubject: Good\r\n\r\nHi\r\n")).map(toBase64);
    const res = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 2, fileName: "bad.mbox", last: true, messages: [good[0], "this is not base64 at all!"] }, { "idempotency-key": "mbox_r49_bad_00001" });
    expect(res.status).toBe(422);
    expect(res.body.error?.message ?? res.body.message).toBe(MBOX_UNREADABLE);
    expect(await ctx.db.select().from(dataMoves)).toHaveLength(0);
    expect(await ctx.db.select().from(messages).where(eq(messages.mailboxId, box.id))).toHaveLength(0);
    // base64url from another exporter is read, not refused.
    const url = good[0].replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const ok = await c.call("POST", "/api/data-moves/mbox/batch", { mailboxId: box.id, total: 1, fileName: "ok.mbox", last: true, messages: [url] }, { "idempotency-key": "mbox_r49_ok_000001" });
    expect(ok.status).toBe(200);
    expect(ok.body.move).toMatchObject({ status: "done", created: 1 });
  });
});
