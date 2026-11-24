/**
 * F6: messages.first_of_sender is right only while the 0171 triggers exist. A later migration that rebuilds the
 * messages table (create new, copy, drop, rename) drops its triggers with it, and the flag would drift without a
 * sound. After every migration, the seven triggers must be there, on messages, and still keep the flag.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";

const EXPECTED = [
  "messages_first_sender_ad_set",
  "messages_first_sender_ai_clear",
  "messages_first_sender_ai_set",
  "messages_first_sender_au_new_clear",
  "messages_first_sender_au_new_set",
  "messages_first_sender_au_old_clear",
  "messages_first_sender_au_old_set",
];

describe("F6: the first sender triggers survive every migration", () => {
  it("all seven exist on messages after the full migration chain", async () => {
    const ctx = await makeTestApp();
    const raw = (ctx.db as unknown as { $client: { prepare: (q: string) => { all: () => unknown[] } } }).$client;
    const rows = raw.prepare("select name, tbl_name from sqlite_master where type = 'trigger' and name like 'messages_first_sender_%' order by name").all() as { name: string; tbl_name: string }[];
    expect(rows.map((r) => r.name)).toEqual(EXPECTED);
    expect(new Set(rows.map((r) => r.tbl_name))).toEqual(new Set(["messages"]));
  });
});
