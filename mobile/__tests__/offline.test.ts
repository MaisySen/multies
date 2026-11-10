import { memoryKV } from "@/lib/kv";
import { cached, searchCache } from "@/lib/offline";
import { ApiError } from "@/api/errors";

describe("offline cache", () => {
  it("returns the saved copy when the network is down", async () => {
    const store = memoryKV();
    await cached(store, "list:live:inbox:all", async () => ({ messages: [{ id: "m1" }], nextCursor: null }));
    const v = await cached(store, "list:live:inbox:all", async () => { throw new ApiError(0, "network", "offline"); });
    expect(v).toEqual({ messages: [{ id: "m1" }], nextCursor: null });
  });

  it("passes real errors through", async () => {
    await expect(cached(memoryKV(), "k", async () => { throw new ApiError(403, "forbidden", "No"); })).rejects.toMatchObject({ status: 403 });
    await expect(cached(memoryKV(), "k", async () => { throw new ApiError(0, "network", "offline"); })).rejects.toMatchObject({ status: 0 });
  });

  it("searches mail already on the phone", async () => {
    const store = memoryKV();
    // PRIV1b (P53): offline search reads only mailboxes in the saved overview, so the test saves one.
    const m = (id: string, subject: string) => ({ id, mailboxId: "mb1", subject, snippet: "", from: { address: "a@b.au" }, to: [], date: "2026-10-2" + id.slice(-1) });
    await store.set("meta:live:overview", JSON.stringify({ v: { mailboxes: [{ id: "mb1" }] } }));
    await store.set("list:live:inbox:all", JSON.stringify({ v: { messages: [m("m1", "Invoice INV-1042"), m("m2", "Lunch")], nextCursor: null } }));
    await store.set("thread:live:m3", JSON.stringify({ v: { message: {}, thread: [{ ...m("m3", "Quote"), text: "the invoice is attached" }] } }));
    const hits = await searchCache(store, "invoice");
    expect(hits.map((h) => h.id).sort()).toEqual(["m1", "m3"]);
  });
});
