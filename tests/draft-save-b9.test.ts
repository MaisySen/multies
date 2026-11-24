/**
 * B9: saving over a draft deleted the old copy before storing the new one, so a store that failed (the body store or
 * the database briefly down) lost the draft. The new copy is stored first now; the old one goes only after that, and a
 * save that loses a race with another window takes its own new copy back out and answers 409.
 */
import { describe, it, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { messages } from "@/server/db/schema";

const fault = vi.hoisted(() => ({ mode: "off" as "off" | "fail" | "race" | "delete", raceId: "" }));
vi.mock("@/server/services/mail/store", async (orig) => {
  const real = await orig<typeof import("@/server/services/mail/store")>();
  return { ...real, storeMessage: async (...a: Parameters<typeof real.storeMessage>) => {
    if (fault.mode === "fail") throw new Error("body store unavailable");
    // Another window saved the same draft while this save was storing: the old copy is gone.
    if (fault.mode === "race") await a[0].delete(messages).where(eq(messages.id, fault.raceId));
    const id = await real.storeMessage(...a);
    // F5: the database fails on the very next delete (the old draft's), once.
    if (fault.mode === "delete") {
      const db = a[0];
      const spy = vi.spyOn(db, "delete").mockImplementationOnce(() => { spy.mockRestore(); throw new Error("injected delete failure"); });
    }
    return id;
  } };
});

async function setup() {
  const ctx = await makeTestApp();
  const c = new Client(ctx.app);
  await c.signup("owner@acme.io");
  const domainId = (await c.post("/api/domains", { name: "acme.io" })).body.domain.id as string;
  const { body } = await c.get(`/api/domains/${domainId}`);
  for (const r of body.domain.records) {
    if (r.id === "mx") ctx.dns.records.mx = { ...ctx.dns.records.mx, [r.fqdn]: r.values.map((v: { value: string; priority: number }) => ({ exchange: v.value, priority: v.priority })) };
    else ctx.dns.records.txt = { ...ctx.dns.records.txt, [r.fqdn]: [r.value] };
  }
  await c.post(`/api/domains/${domainId}/verify`);
  const mailboxId = (await c.post("/api/mailboxes", { domainId, localPart: "hello", displayName: "Hello" })).body.mailbox.id as string;
  const drafts = async () => (await ctx.db.select({ id: messages.id, subject: messages.subject }).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.folder, "drafts"))).all());
  return { ctx, c, mailboxId, drafts };
}

describe("B9: saving over a draft never loses it", () => {
  it("a store that fails leaves the old draft in place", async () => {
    const { c, mailboxId, drafts } = await setup();
    fault.mode = "off";
    const first = (await c.post("/api/mail/drafts", { mailboxId, to: ["a@b.io"], subject: "v1", text: "first words" })).body.id as string;
    fault.mode = "fail";
    const r = await c.post("/api/mail/drafts", { id: first, mailboxId, to: ["a@b.io"], subject: "v2", text: "second words" });
    fault.mode = "off";
    expect(r.status).toBe(500);
    expect(await drafts()).toEqual([{ id: first, subject: "v1" }]);
    // And a normal save over it still replaces it.
    const second = await c.post("/api/mail/drafts", { id: first, mailboxId, to: ["a@b.io"], subject: "v3", text: "third" });
    expect(second.status).toBe(201);
    expect(await drafts()).toEqual([{ id: second.body.id, subject: "v3" }]);
  }, 60_000);

  it("when deleting the old copy fails, the new copy is taken back out, so a retry leaves one draft (F5)", async () => {
    const { c, mailboxId, drafts } = await setup();
    fault.mode = "off";
    const first = (await c.post("/api/mail/drafts", { mailboxId, to: ["a@b.io"], subject: "v1", text: "first" })).body.id as string;
    fault.mode = "delete";
    const r = await c.post("/api/mail/drafts", { id: first, mailboxId, to: ["a@b.io"], subject: "v2", text: "second" });
    fault.mode = "off";
    expect(r.status).toBe(500);
    expect(await drafts()).toEqual([{ id: first, subject: "v1" }]);
    // The autosaver's retry of the same save replaces it cleanly.
    const again = await c.post("/api/mail/drafts", { id: first, mailboxId, to: ["a@b.io"], subject: "v2", text: "second" });
    expect(again.status).toBe(201);
    expect(await drafts()).toEqual([{ id: again.body.id, subject: "v2" }]);
  }, 60_000);

  it("a save that loses the race answers 409 and leaves no extra copy", async () => {
    const { c, mailboxId, drafts } = await setup();
    fault.mode = "off";
    const first = (await c.post("/api/mail/drafts", { mailboxId, to: ["a@b.io"], subject: "v1", text: "first" })).body.id as string;
    fault.mode = "race"; fault.raceId = first;
    const r = await c.post("/api/mail/drafts", { id: first, mailboxId, to: ["a@b.io"], subject: "late", text: "late window" });
    fault.mode = "off";
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("draft_changed");
    expect(await drafts()).toEqual([]);
  }, 60_000);
});
