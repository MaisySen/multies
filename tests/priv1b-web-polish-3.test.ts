/**
 * PRIV1b web-polish-3: WP1 (a fresh mail overview drops stored offline list copies of mailboxes it no longer lists, so
 * a share that ended while the person was in another mailbox leaves nothing on the device), WP2 (Compose fills in
 * From when the mailbox list arrives after it opened: a test that fails when that effect is removed).
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privacyWorld } from "./priv1a-world";
import {
  dropMailCopiesNotIn, readCopy, saveCopy, setOfflineScope, setOfflineStoreForTests, wipeOfflineLists, withOfflineCopy, type OfflineStore, type StoredCopy,
} from "@/web/lib/offline-lists";
import { defaultFrom, fillFrom } from "@/web/lib/mail-level-priv1b";

function memoryStore(): OfflineStore & { map: Map<string, StoredCopy> } {
  const map = new Map<string, StoredCopy>();
  return {
    map,
    get: async (k) => map.get(k),
    put: async (c) => void map.set(c.key, c),
    delete: async (k) => void map.delete(k),
    all: async () => [...map.values()],
    clear: async () => map.clear(),
  };
}
const A = { userId: "usr_A", orgId: "org_1" };
const A2 = { userId: "usr_A", orgId: "org_2" };
const B = { userId: "usr_B", orgId: "org_1" };
afterEach(async () => { await wipeOfflineLists(null); setOfflineStoreForTests(undefined as unknown as null); });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("PRIV1b (WP1): a fresh overview drops stored lists of mailboxes it no longer lists", () => {
  it("copies of a mailbox missing from the overview go; listed mailboxes, other lists, workspaces and people stay", async () => {
    const st = memoryStore();
    setOfflineStoreForTests(st);
    setOfflineScope(A);
    await saveCopy("mail:mbx_P:inbox:", { messages: [{ id: "secret" }] }, A, st);
    await saveCopy("mail:mbx_P:archive:", { messages: [{ id: "old" }] }, A, st);
    await saveCopy("mail:mbx_T:inbox:", { messages: [{ id: "team" }] }, A, st);
    await saveCopy("mail:mbx_PX:inbox:", { messages: [{ id: "own" }] }, A, st);
    await saveCopy("my-work", { tasks: [{ id: "t1" }] }, A, st);
    await saveCopy("mail:mbx_P:inbox:", { messages: [{ id: "other workspace" }] }, A2, st);
    await saveCopy("mail:mbx_P:inbox:", { messages: [{ id: "B's own" }] }, B, st);
    // The share on mbx_P ended while A was in mbx_T: the next overview lists mbx_T and mbx_PX only.
    await dropMailCopiesNotIn(["mbx_T", "mbx_PX"], A, st);
    expect(await readCopy("mail:mbx_P:inbox:", A, st)).toBeUndefined();
    expect(await readCopy("mail:mbx_P:archive:", A, st)).toBeUndefined();
    await expect(withOfflineCopy("mail:mbx_P:inbox:", offline)()).rejects.toThrow();
    // Legitimate: mailboxes still in the overview, other lists, another workspace and another person keep theirs.
    expect(await withOfflineCopy("mail:mbx_T:inbox:", offline)()).toEqual({ messages: [{ id: "team" }] });
    expect(await readCopy("mail:mbx_PX:inbox:", A, st)).toBeDefined();
    expect(await readCopy("my-work", A, st)).toBeDefined();
    expect(await readCopy("mail:mbx_P:inbox:", A2, st)).toBeDefined();
    expect(await readCopy("mail:mbx_P:inbox:", B, st)).toBeDefined();
  });

  it("a delegate whose share is taken back: the overview ids drop the copy; the owner's overview keeps it", async () => {
    const w = await privacyWorld();
    const ids = async (c: typeof w.pat.c) => ((await c.get("/api/mail/overview")).body.mailboxes as { id: string }[]).map((m) => m.id);
    const st = memoryStore();
    const list = `mail:${w.boxes.personal}:inbox:`;
    // While shared, the delegate's overview lists the mailbox and the copy stays.
    expect(await ids(w.dRead.c)).toContain(w.boxes.personal);
    await saveCopy(list, { messages: [{ id: "private" }] }, A, st);
    await dropMailCopiesNotIn(await ids(w.dRead.c), A, st);
    expect(await readCopy(list, A, st)).toBeDefined();
    // The owner takes the share back.
    expect((await w.pat.c.del(`/api/mailboxes/${w.boxes.personal}/sharing/${w.dRead.id}`)).status).toBe(200);
    const after = await ids(w.dRead.c);
    expect(after).not.toContain(w.boxes.personal);
    await dropMailCopiesNotIn(after, A, st);
    expect(await readCopy(list, A, st)).toBeUndefined();
    // Legitimate: the owner's overview keeps their own mailbox, so their copy stays.
    await saveCopy(list, { messages: [{ id: "mine" }] }, B, st);
    await dropMailCopiesNotIn(await ids(w.pat.c), B, st);
    expect(await readCopy(list, B, st)).toBeDefined();
  }, 120_000);

  it("the page runs it whenever a fresh overview arrives", () => {
    const src = readFileSync(join(__dirname, "../src/web/pages/app/webmail.tsx"), "utf8");
    expect(src).toMatch(/useEffect\(\(\) => \{ if \(overview\.data\) void dropMailCopiesNotIn\(overview\.data\.map\(\(m\) => m\.id\)\); \}, \[overview\.data\]\);/);
  });
});

describe("PRIV1b (WP2): Compose fills in From when the mailbox list arrives late", () => {
  it("the effect re-runs on the mailbox list and fills an empty From only", () => {
    const src = readFileSync(join(__dirname, "../src/web/pages/app/mail/compose.tsx"), "utf8");
    const body = src.slice(src.indexOf("export function Compose("));
    expect(body).toMatch(/useEffect\(\(\) => \{ setD\(\(x\) => \{ const id = fillFrom\(x\.mailboxId, mailboxes, initial\); return id === x\.mailboxId \? x : \{ \.\.\.x, mailboxId: id \}; \}\); \}, \[mailboxes, initial\]\);/);
  });

  it("the state steps: opened before the list (empty From), then the list arrives, then the person's choice stays", () => {
    const initial = { mailboxId: "team" };
    // Compose opened while the list was still loading: useState's first value has no From, so Send stays off.
    let from = defaultFrom([], initial);
    expect(from).toBe("");
    // The list arrives: the effect gives the default.
    const boxes = [{ id: "pread", level: "read" as const }, { id: "team", level: "team" as const }, { id: "psend", level: "send_as" as const }];
    from = fillFrom(from, boxes, initial);
    expect(from).toBe("team");
    // The person picks another From; a refetch of the list does not undo it.
    from = fillFrom("psend", boxes, initial);
    expect(from).toBe("psend");
    // A read share is never filled in.
    expect(fillFrom("", [{ id: "pread", level: "read" }], { mailboxId: "pread" })).toBe("");
  });
});
