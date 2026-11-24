/**
 * Wave 3 review Y8 (d): the workspace export parsed each message's to, cc and bcc with JSON.parse, so one row with a
 * list that isn't JSON (older rows, some imports) failed the whole export with a 500. Lists now come out as
 * [{ address, name? }] like the API, and a value that can't be read is kept as it was, beside an empty list.
 */
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { verifiedDomain } from "./priv1a-world";
import { mailboxes, messages } from "@/server/db/schema";

describe("Y8 (d): the export reads every address list", () => {
  it("normalises readable lists and keeps an unreadable one raw, without a 500", async () => {
    const ctx = await makeTestApp();
    const owner = new Client(ctx.app);
    await owner.signup("owner@example.com");
    const domainId = await verifiedDomain(ctx, owner, "acme.io");
    const mb = (await owner.post("/api/mailboxes", { domainId, localPart: "ada", displayName: "Ada" })).body.mailbox.id as string;
    const orgId = (await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, mb)).get())!.orgId;
    await ctx.db.insert(messages).values({ id: "msg_y8dexport000001", orgId, mailboxId: mb, folder: "inbox", threadId: "thr_y8dexport00001", fromAddress: "bob@example.com", fromName: "Bob",
      to: "ada@acme.io; not json", cc: '["carl@example.com"]', bcc: '[{"address":"dee@example.com","name":"Dee"},{"nope":1}]', subject: "Old row", text: "x", snippet: "x", date: new Date(), isRead: true });
    const res = await ctx.app.request("/api/account/workspace/export", { headers: { cookie: owner.cookie, host: "localhost" } });
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const mail = strFromU8(files["mail/ada@acme.io.jsonl"]!).trim().split("\n").map((l) => JSON.parse(l));
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      subject: "Old row",
      to: [], toRaw: "ada@acme.io; not json",
      cc: [{ address: "carl@example.com" }],
      bcc: [{ address: "dee@example.com", name: "Dee" }], bccRaw: '[{"address":"dee@example.com","name":"Dee"},{"nope":1}]',
    });
    expect(mail[0]).not.toHaveProperty("ccRaw");
  });
});
