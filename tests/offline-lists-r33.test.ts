import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/web/lib/api";
import {
  copyKey, evictionsFor, isOfflineError, MAX_ROWS, readCopy, saveCopy, scopeOf, setOfflineScope, setOfflineStoreForTests,
  shownCopyAt, trimRows, wipeOfflineLists, withOfflineCopy, type OfflineStore, type StoredCopy,
} from "@/web/lib/offline-lists";

function memoryStore(): OfflineStore & { map: Map<string, StoredCopy> } {
  const map = new Map<string, StoredCopy>();
  return {
    map,
    get: async (k) => map.get(k),
    put: async (c) => { map.set(c.key, c); },
    delete: async (k) => { map.delete(k); },
    all: async () => [...map.values()],
    clear: async () => { map.clear(); },
  };
}

const A = { userId: "usr_a", orgId: "org_1" };
const B = { userId: "usr_b", orgId: "org_1" };

afterEach(async () => { await wipeOfflineLists(null); setOfflineStoreForTests(undefined as unknown as null); });

describe("R33 offline lists: keying", () => {
  it("keys by person, workspace and list", () => {
    expect(copyKey(A, "my-work")).toBe("v1|usr_a|org_1|my-work");
    expect(copyKey(A, "my-work")).not.toBe(copyKey(B, "my-work"));
    expect(copyKey(A, "my-work")).not.toBe(copyKey({ userId: "usr_a", orgId: "org_2" }, "my-work"));
    expect(copyKey({ userId: "a|b", orgId: "o" }, "x")).toBe("v1|a_b|o|x");
  });

  it("builds the scope from /account/me, and none when nobody is signed in", () => {
    expect(scopeOf({ user: { id: "usr_a" }, organization: { id: "org_1" } })).toEqual(A);
    expect(scopeOf({ user: { id: "usr_a" }, organization: null })).toEqual({ userId: "usr_a", orgId: "personal" });
    expect(scopeOf(null)).toBeNull();
    expect(scopeOf({ user: null })).toBeNull();
  });

  it("another person on the same device never reads the first person's copy", async () => {
    const st = memoryStore();
    await saveCopy("my-work", { overdue: [{ id: "t1" }] }, A, st, 1000);
    expect((await readCopy("my-work", A, st))?.data).toEqual({ overdue: [{ id: "t1" }] });
    expect(await readCopy("my-work", B, st)).toBeUndefined();
    expect(await readCopy("my-work", null, st)).toBeUndefined();
  });
});

describe("R33 offline lists: bounds", () => {
  it("keeps the first 200 rows of an array or of each list field", () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: i }));
    expect(trimRows(rows)).toHaveLength(MAX_ROWS);
    const t = trimRows({ date: "2026-10-26", dueToday: rows, mentions: rows.slice(0, 3) });
    expect(t.dueToday).toHaveLength(200);
    expect(t.mentions).toHaveLength(3);
    expect(t.date).toBe("2026-10-26");
  });

  it("drops the oldest copies past the byte budget and never the newest", () => {
    const drop = evictionsFor([{ key: "old", at: 1, bytes: 60 }, { key: "mid", at: 2, bytes: 30 }, { key: "new", at: 3, bytes: 30 }], 100);
    expect(drop).toEqual(["old"]);
    expect(evictionsFor([{ key: "huge", at: 9, bytes: 500 }], 100)).toEqual([]);
  });

  it("only a lost connection counts as offline", () => {
    expect(isOfflineError(new ApiError(0, "network", "x"))).toBe(true);
    expect(isOfflineError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isOfflineError(new ApiError(500, "server", "x"))).toBe(false);
    expect(isOfflineError(new ApiError(401, "auth", "x"))).toBe(false);
  });
});

describe("R33 offline lists: the query wrapper and sign out", () => {
  it("stores a fresh answer, serves it when the network fails, and says from when", async () => {
    const st = memoryStore();
    setOfflineStoreForTests(st);
    setOfflineScope(A);
    const fresh = await withOfflineCopy("tasks?", async () => [{ id: "t1" }])();
    expect(fresh).toEqual([{ id: "t1" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(st.map.size).toBe(1);
    const offline = await withOfflineCopy("tasks?", async () => { throw new ApiError(0, "network", "down"); })();
    expect(offline).toEqual([{ id: "t1" }]);
    expect(shownCopyAt()).toBeTypeOf("number");
    await withOfflineCopy("tasks?", async () => [{ id: "t2" }])();
    expect(shownCopyAt()).toBeNull();
  });

  it("server errors still surface; no copy means the error surfaces", async () => {
    const st = memoryStore();
    setOfflineStoreForTests(st);
    setOfflineScope(A);
    await expect(withOfflineCopy("x", async () => { throw new ApiError(500, "server", "boom"); })()).rejects.toThrow("boom");
    await expect(withOfflineCopy("never", async () => { throw new ApiError(0, "network", "down"); })()).rejects.toThrow("down");
  });

  it("sign out wipes every stored list and forgets the scope", async () => {
    const st = memoryStore();
    setOfflineStoreForTests(st);
    setOfflineScope(A);
    await saveCopy("my-work", { overdue: [] }, A, st);
    await saveCopy("tasks?", [], B, st);
    await wipeOfflineLists(st);
    expect(st.map.size).toBe(0);
    await saveCopy("my-work", { overdue: [] }, undefined, st);
    expect(st.map.size).toBe(0);
  });
});
