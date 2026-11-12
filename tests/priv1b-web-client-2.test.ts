/**
 * PRIV1b web-client-2 (review notes on the web batch): WC1 (Mail loads the URL's mailbox before the overview, which
 * has no offline copy), WC2 (From takes its default when the mailbox list arrives after Compose opened), WC3 (taking
 * over a draft offers From from the overview levels), WC4 (a mailbox that answers 404 loses its stored offline list
 * copy), WC5 (the other mailbox pickers list only mailboxes the person can open).
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { privacyWorld } from "./priv1a-world";
import {
  dropCopies, readCopy, saveCopy, setOfflineScope, setOfflineStoreForTests, wipeOfflineLists, withOfflineCopy, type OfflineStore, type StoredCopy,
} from "@/web/lib/offline-lists";
import { fillFrom, fromChoices, mailCopyPrefix, openableOnly, pickMailbox } from "@/web/lib/mail-level-priv1b";

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
const B = { userId: "usr_B", orgId: "org_1" };
afterEach(async () => { await wipeOfflineLists(null); setOfflineStoreForTests(undefined as unknown as null); });

describe("PRIV1b (WC1): the URL's mailbox opens before the overview answers", () => {
  it("no overview yet (offline, or slow): the ?mailbox= one loads at once; once in, the overview decides", () => {
    expect(pickMailbox("mbx_P", undefined, undefined)).toBe("mbx_P");
    // The overview has it: kept.
    expect(pickMailbox("mbx_P", [{ id: "mbx_T" }, { id: "mbx_P" }], "mbx_T")).toBe("mbx_P");
    // The overview does not (a share taken back): the busiest one opens instead, never the asked one.
    expect(pickMailbox("mbx_P", [{ id: "mbx_T" }], "mbx_T")).toBe("mbx_T");
    expect(pickMailbox("mbx_P", [], undefined)).toBe("");
    // No ?mailbox=: the busiest one, or nothing while the overview loads.
    expect(pickMailbox(null, undefined, undefined)).toBe("");
    expect(pickMailbox(null, [{ id: "mbx_T" }], "mbx_T")).toBe("mbx_T");
  });

  it("the page renders the list without the overview when a mailbox is asked for", () => {
    const src = readFileSync(join(__dirname, "../src/web/pages/app/webmail.tsx"), "utf8");
    expect(src).toContain("pickMailbox(wantedBox, overview.data, busiest?.id)");
    expect(src).toMatch(/if \(overview\.isPending && !early\)/);
  });
});

describe("PRIV1b (WC2): From when the mailbox list arrives late", () => {
  it("nothing chosen and the list arrives: the default From is set (Send can turn on)", () => {
    const draft = { mailboxId: "team" };
    expect(fillFrom("", [], draft)).toBe("");
    expect(fillFrom("", [{ id: "team", level: "team" }], draft)).toBe("team");
    // A read share asked for: not taken; the first mailbox that can send is.
    expect(fillFrom("", [{ id: "pread", level: "read" }, { id: "team", level: "team" }], { mailboxId: "pread" })).toBe("team");
    expect(fillFrom("", [{ id: "pread", level: "read" }], { mailboxId: "pread" })).toBe("");
    // The person's own choice stays.
    expect(fillFrom("psend", [{ id: "team", level: "team" }, { id: "psend", level: "send_as" }], draft)).toBe("psend");
  });
});

describe("PRIV1b (WC3): take over a draft offers From from the overview levels", () => {
  it("a read share's overview row is no From; the owner's is; the take over panel reads the overview", async () => {
    const src = readFileSync(join(__dirname, "../src/web/pages/app/inbox-presence.tsx"), "utf8");
    expect(src).not.toMatch(/useMailboxes\(/);
    expect(src).toContain("useMailOverview()");
    const w = await privacyWorld();
    const ov = async (c: typeof w.pat.c) => (await c.get("/api/mail/overview")).body.mailboxes as { id: string; level?: "own" | "send_as" | "reply" | "read" | "team" }[];
    const reader = await ov(w.dRead.c);
    expect(reader.find((m) => m.id === w.boxes.personal)?.level).toBe("read");
    expect(fromChoices(reader, { mailboxId: w.boxes.personal, inReplyToId: "m1" }).some((m) => m.id === w.boxes.personal)).toBe(false);
    expect(fillFrom("", reader, { mailboxId: w.boxes.personal, inReplyToId: "m1" })).not.toBe(w.boxes.personal);
    // Legitimate: the owner keeps their own mailbox as From.
    const owner = await ov(w.pat.c);
    expect(fillFrom("", owner, { mailboxId: w.boxes.personal, inReplyToId: "m1" })).toBe(w.boxes.personal);
  }, 120_000);
});

describe("PRIV1b (WC4): a gone mailbox loses its stored offline list", () => {
  it("dropCopies removes that mailbox's copies only, and an offline read then has nothing to show", async () => {
    const st = memoryStore();
    setOfflineStoreForTests(st);
    setOfflineScope(A);
    await saveCopy("mail:mbx_P:inbox:", { messages: [{ id: "secret" }] }, A, st);
    await saveCopy("mail:mbx_P:archive:", { messages: [{ id: "old" }] }, A, st);
    await saveCopy("mail:mbx_PX:inbox:", { messages: [{ id: "other box" }] }, A, st);
    await saveCopy("mail:mbx_T:inbox:", { messages: [{ id: "team" }] }, A, st);
    await saveCopy("mail:mbx_P:inbox:", { messages: [{ id: "B's own" }] }, B, st);
    await dropCopies(mailCopyPrefix("mbx_P"), A, st);
    expect(await readCopy("mail:mbx_P:inbox:", A, st)).toBeUndefined();
    expect(await readCopy("mail:mbx_P:archive:", A, st)).toBeUndefined();
    // Legitimate: other mailboxes (even one whose id starts the same) and another person's copies stay.
    expect(await readCopy("mail:mbx_PX:inbox:", A, st)).toBeDefined();
    expect(await readCopy("mail:mbx_T:inbox:", A, st)).toBeDefined();
    expect(await readCopy("mail:mbx_P:inbox:", B, st)).toBeDefined();
    const offline = () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(withOfflineCopy("mail:mbx_P:inbox:", offline)()).rejects.toThrow();
    expect(await withOfflineCopy("mail:mbx_T:inbox:", offline)()).toEqual({ messages: [{ id: "team" }] });
  });

  it("the page drops the copy when the list answers 404", () => {
    const src = readFileSync(join(__dirname, "../src/web/pages/app/webmail.tsx"), "utf8");
    expect(src).toContain("void dropCopies(mailCopyPrefix(goneBox))");
  });
});

describe("PRIV1b (WC5): mailbox pickers list only mailboxes the person can open", () => {
  const pages = [
    "agents.tsx", "helpdesk-settings.tsx", "tools-automation/campaigns-r109.tsx", "tools-automation/campaigns-r109-editor.tsx", "tools-automation/merge.tsx",
    "tools-share-sign/sign.tsx", "tools-share-sign/templates.tsx", "data-move-mbox.tsx", "import-section.tsx", "mail-apps.tsx", "work/automation-assign.tsx", "blog-r124.tsx",
  ];
  it.each(pages)("%s uses the openable list", (p) => {
    const src = readFileSync(join(__dirname, "../src/web/pages/app", p), "utf8");
    expect(src).not.toMatch(/useMailboxes\(/);
    expect(src).toContain("useOpenableMailboxes()");
  });

  it("an admin's picker leaves out a colleague's private mailbox and keeps team and own mailboxes", async () => {
    const q = readFileSync(join(__dirname, "../src/web/lib/queries.ts"), "utf8");
    expect(q).toMatch(/useOpenableMailboxes = [^\n]*select: openRows/);
    const w = await privacyWorld();
    const rows = (await w.admin.c.get("/api/mailboxes")).body.mailboxes as { id: string; openable?: boolean }[];
    expect(rows.some((m) => m.id === w.boxes.personal)).toBe(true); // the raw list has it (as a reduced row)
    const picked = openableOnly(rows).map((m) => m.id);
    expect(picked).not.toContain(w.boxes.personal);
    expect(picked).toContain(w.boxes.team);
    const own = openableOnly((await w.pat.c.get("/api/mailboxes")).body.mailboxes as { id: string; openable?: boolean }[]).map((m) => m.id);
    expect(own).toContain(w.boxes.personal);
  }, 120_000);
});
