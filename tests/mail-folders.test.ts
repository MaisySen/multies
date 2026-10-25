/**
 * Folders beyond Inbox and Sent for connected mailboxes (round 19): the provider's folder list,
 * Archive, Drafts, Spam and Trash synced, the person's own folders on demand, and moves both ways
 * (made in Multies and applied at the provider; made at the provider and picked up by Multies).
 */
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { FakeImapServer, FakeSmtpServer, rawMail } from "./fake-mail-servers";
import { mailConnections, mailSyncOutbox, messages, users } from "@/server/db/schema";
import { syncConnection, syncedKeys, localFolderFor, MAX_EXTRA_FOLDERS, parseState } from "@/server/services/connect/sync";
import { folderViews, canMoveTo } from "@/server/services/connect/folders";
import { pickFolders } from "@/server/services/connect/imap";

const ME = "ada@fastmail.com";
const PW = "fm-app-pass";
let n = 0;
const mail = (subject: string) => rawMail({ to: ME, subject, id: `<f-${++n}-${Date.now()}@navy.mil>` });

async function setup() {
  const ctx = await makeTestApp({ MAIL_SYNC_BATCH: "50" });
  const imap = new FakeImapServer().addAccount(ME, PW);
  const smtp = new FakeSmtpServer();
  smtp.accounts.set(ME, PW);
  ctx.deps.imap = imap.connector;
  ctx.deps.openSocket = smtp.opener;
  const c = new Client(ctx.app);
  const email = await c.signup(undefined, "Ada Lovelace", "Acme");
  await ctx.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  imap.deliver(ME, mail("Hello inbox"));
  expect((await c.post("/api/connections", { email: ME, password: PW })).status).toBe(201);
  const conn = (await ctx.db.select().from(mailConnections).get())!;
  const sync = () => syncConnection(ctx.deps, conn.id, { force: true });
  const bySubject = async (subject: string) => (await ctx.db.select().from(messages).where(and(eq(messages.mailboxId, conn.mailboxId), eq(messages.subject, subject))));
  return { ctx, imap, c, conn, sync, bySubject };
}

describe("folder keys", () => {
  it("files the person's own folders under Archive and picks Drafts and Spam by special use or name", () => {
    expect(localFolderFor("f:Clients/Acme")).toBe("archive");
    expect(localFolderFor("spam")).toBe("spam");
    expect(pickFolders([{ path: "INBOX" }, { path: "Junk E-mail" }, { path: "Entwürfe", specialUse: "\\Drafts" }, { path: "[Gmail]/Spam" }])).toMatchObject({ spam: "Junk E-mail", drafts: "Entwürfe" });
    const state = { paths: { inbox: "INBOX", sent: "Sent", archive: "Archive", drafts: "Drafts", spam: "Junk", trash: "Trash" }, extra: ["Clients/Acme", "Archive"] };
    // A path that is already a standard folder isn't synced twice.
    expect(syncedKeys(state)).toEqual(["inbox", "sent", "archive", "drafts", "spam", "trash", "f:Clients/Acme"]);
    expect(canMoveTo(state, "f:Clients/Acme")).toBe(true);
    expect(canMoveTo(state, "f:Other")).toBe(false);
    expect(canMoveTo({ paths: { inbox: "INBOX" } }, "spam")).toBe(false);
  });
});

describe("standard folders sync", () => {
  it("copies Archive, Drafts, Spam and Trash into the matching Multies folders", async () => {
    const { imap, sync, bySubject } = await setup();
    imap.deliver(ME, mail("Old archived"), { folder: "Archive" });
    imap.deliver(ME, mail("Half written"), { folder: "Drafts" });
    imap.deliver(ME, mail("Win a prize"), { folder: "Junk" });
    imap.deliver(ME, mail("Thrown away"), { folder: "Trash" });
    await sync();
    expect((await bySubject("Old archived"))[0]).toMatchObject({ folder: "archive", remoteBox: "archive" });
    expect((await bySubject("Half written"))[0]).toMatchObject({ folder: "drafts", remoteBox: "drafts", isRead: true });
    expect((await bySubject("Win a prize"))[0]).toMatchObject({ folder: "spam", remoteBox: "spam" });
    expect((await bySubject("Thrown away"))[0]).toMatchObject({ folder: "trash", remoteBox: "trash" });
  });
});

describe("the provider's folder list", () => {
  it("lists every folder with its role, and the person's own folders sync on demand", async () => {
    const { ctx, imap, c, conn, sync, bySubject } = await setup();
    imap.deliver(ME, mail("Acme invoice"), { folder: "Clients/Acme" });
    const listed = await c.get(`/api/connections/${conn.id}/folders`);
    expect(listed.status).toBe(200);
    const acme = listed.body.folders.find((f: { path: string }) => f.path === "Clients/Acme");
    expect(acme).toMatchObject({ key: "f:Clients/Acme", role: null, synced: false, name: "Acme" });
    expect(listed.body.folders.find((f: { role: string }) => f.role === "spam")).toMatchObject({ path: "Junk", synced: true });
    await sync();
    expect(await bySubject("Acme invoice")).toHaveLength(0);

    const on = await c.put(`/api/connections/${conn.id}/folders`, { path: "Clients/Acme", sync: true });
    expect(on.status).toBe(200);
    expect(on.body.folders.find((f: { path: string }) => f.path === "Clients/Acme").synced).toBe(true);
    // Turning a folder on runs a pass straight away.
    expect((await bySubject("Acme invoice"))[0]).toMatchObject({ folder: "archive", remoteBox: "f:Clients/Acme" });
    const list = await c.get(`/api/mail/messages?mailboxId=${conn.mailboxId}&remote=${encodeURIComponent("f:Clients/Acme")}`);
    expect(list.body.messages.map((m: { subject: string }) => m.subject)).toEqual(["Acme invoice"]);

    // Standard folders always sync; unknown folders are refused.
    expect((await c.put(`/api/connections/${conn.id}/folders`, { path: "Junk", sync: false })).status).toBe(400);
    expect((await c.put(`/api/connections/${conn.id}/folders`, { path: "Nope", sync: true })).status).toBe(400);
    // Off: keeps what was copied, syncs no more.
    await c.put(`/api/connections/${conn.id}/folders`, { path: "Clients/Acme", sync: false });
    imap.deliver(ME, mail("Acme later"), { folder: "Clients/Acme" });
    await sync();
    expect(await bySubject("Acme later")).toHaveLength(0);
    expect(await bySubject("Acme invoice")).toHaveLength(1);
    expect(ctx).toBeTruthy();
  });

  it("caps the person's own folders, and drops a folder deleted at the provider", async () => {
    const { ctx, imap, c, conn, sync } = await setup();
    for (let i = 0; i < MAX_EXTRA_FOLDERS + 1; i++) imap.addFolder(ME, `P${i}`);
    await c.get(`/api/connections/${conn.id}/folders?refresh=1`);
    for (let i = 0; i < MAX_EXTRA_FOLDERS; i++) expect((await c.put(`/api/connections/${conn.id}/folders`, { path: `P${i}`, sync: true })).status).toBe(200);
    const over = await c.put(`/api/connections/${conn.id}/folders`, { path: `P${MAX_EXTRA_FOLDERS}`, sync: true });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toMatch(/Up to 10/);
    imap.removeFolder(ME, "P0");
    await sync();
    const state = parseState((await ctx.db.select().from(mailConnections).where(eq(mailConnections.id, conn.id)).get())!.syncState);
    expect(state.extra).not.toContain("P0");
    expect(folderViews(state).length).toBeGreaterThan(5);
  });
});

describe("moving mail", () => {
  it("a move in Multies lists in the new folder and moves at the provider straight away, keeping its new UID", async () => {
    const { imap, c, conn, sync, bySubject } = await setup();
    await c.put(`/api/connections/${conn.id}/folders`, { path: "Clients/Acme", sync: true });
    const [m] = await bySubject("Hello inbox");
    const moved = await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "move", to: "f:Clients/Acme" });
    expect(moved.body.updated).toBe(1);
    // The move reaches the provider straight away (a pass runs after a move), not at the next scheduled pass.
    const now = (await bySubject("Hello inbox"))[0];
    expect(now).toMatchObject({ folder: "archive", remoteBox: "f:Clients/Acme" });
    expect(imap.subjects(ME, "INBOX")).not.toContain("Hello inbox");
    expect(imap.subjects(ME, "Clients/Acme")).toContain("Hello inbox");
    const after = (await bySubject("Hello inbox"));
    expect(after).toHaveLength(1);
    expect(after[0].remoteUid).toBeGreaterThan(0);
    // A read in Multies now reaches the message in its new folder.
    await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "read" });
    await sync();
    expect(imap.folder(ME, "Clients/Acme").msgs[0].flags.has("\\Seen")).toBe(true);
    // And back to the Inbox, both sides.
    await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "inbox" });
    expect((await bySubject("Hello inbox"))[0].folder).toBe("inbox");
    expect(imap.subjects(ME, "INBOX")).toContain("Hello inbox");
    expect(imap.subjects(ME, "Clients/Acme")).not.toContain("Hello inbox");
  });

  it("without UIDPLUS the moved message is matched by Message-ID, never copied twice", async () => {
    const { imap, c, sync, bySubject } = await setup();
    imap.uidplus = false;
    const [m] = await bySubject("Hello inbox");
    await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "spam" });
    await sync();
    expect(imap.subjects(ME, "Junk")).toContain("Hello inbox");
    await sync();
    const rows = await bySubject("Hello inbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ folder: "spam", remoteBox: "spam" });
    expect(rows[0].remoteUid).toBeGreaterThan(0);
  });

  it("a move made at the provider moves the message in Multies too", async () => {
    const { imap, c, conn, sync, bySubject } = await setup();
    await c.put(`/api/connections/${conn.id}/folders`, { path: "Clients/Acme", sync: true });
    imap.moveAt(ME, "INBOX", "Hello inbox", "Clients/Acme");
    await sync();
    let rows = await bySubject("Hello inbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ folder: "archive", remoteBox: "f:Clients/Acme" });
    imap.moveAt(ME, "Clients/Acme", "Hello inbox", "Trash");
    await sync();
    await sync();
    rows = await bySubject("Hello inbox");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ folder: "trash", remoteBox: "trash" });
  });

  it("refuses a move to a folder that isn't synced, and moves nothing that isn't synced mail", async () => {
    const { ctx, c, bySubject } = await setup();
    const [m] = await bySubject("Hello inbox");
    const r = await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "move", to: "f:Clients/Acme" });
    expect(r.status).toBe(400);
    expect((await bySubject("Hello inbox"))[0].folder).toBe("inbox");
    expect(await ctx.db.select().from(mailSyncOutbox)).toHaveLength(0);
    expect((await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "move" })).status).toBe(400);
  });

  it("read and star wait for the next pass; moves don't", async () => {
    const { imap, c, bySubject, ctx } = await setup();
    const [m] = await bySubject("Hello inbox");
    await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "star" });
    expect(await ctx.db.select().from(mailSyncOutbox)).toHaveLength(1);
    expect(imap.folder(ME, "INBOX").msgs[0].flags.has("\\Flagged")).toBe(false);
    await c.post("/api/mail/messages/bulk", { ids: [m.id], action: "archive" });
    expect(await ctx.db.select().from(mailSyncOutbox)).toHaveLength(0);
    expect(imap.subjects(ME, "Archive")).toContain("Hello inbox");
    expect(imap.folder(ME, "Archive").msgs[0].flags.has("\\Flagged")).toBe(true);
  });
});

describe("the reader's Move to list", () => {
  it("offers the standard folders and synced own folders, not the one the message is in", async () => {
    const { moveTargets } = await import("@/web/pages/app/mail/provider-folders");
    const data = { maxExtra: 10, folders: [
      { key: "inbox", path: "INBOX", name: "Inbox", role: "inbox", synced: true },
      { key: "sent", path: "Sent", name: "Sent", role: "sent", synced: true },
      { key: "spam", path: "Junk", name: "Junk", role: "spam", synced: true },
      { key: "f:Clients/Acme", path: "Clients/Acme", name: "Acme", role: null, synced: true },
      { key: "f:Old", path: "Old", name: "Old", role: null, synced: false },
    ] };
    expect(moveTargets(data, "inbox")).toEqual([{ key: "spam", label: "Spam" }, { key: "f:Clients/Acme", label: "Clients/Acme" }]);
  });
});
