/**
 * MB-367 (privacy): members were shown other people's personal mailbox rows (their addresses) by GET /api/mailboxes.
 * PRIV1b (P23, PR 19) already narrows that list; this pins it, and checks that no other list a member can read gives
 * the addresses away either: Pat's personal address, her free address and the Gmail she connected.
 */
import { describe, it, expect } from "vitest";
import { privacyWorld } from "./priv1a-world";
import { memberSafeAudit } from "@/server/routes/dashboard";

// Every list a plain member can read in this world (each answers 200 for a member; checked below).
const MEMBER_LISTS = ["/api/mailboxes", "/api/aliases", "/api/connections", "/api/counts", "/api/dashboard", "/api/one-inbox", "/api/team", "/api/org", "/api/account/me",
  "/api/mail/messages", "/api/mail/labels", "/api/mail/rules", "/api/mail/prefs", "/api/contacts", "/api/notifications", "/api/deliveries", "/api/domains", "/api/free-address",
  "/api/mailboxes/privacy/mine"];

describe("MB-367: members never see someone else's personal mailboxes", () => {
  it("no list a member or a person with no grant can read carries Pat's personal addresses; a share still sees the one shared", async () => {
    const w = await privacyWorld({ real: true });
    const pat = (await w.pat.c.get("/api/mailboxes")).body.mailboxes as { id: string; address: string; personal: boolean }[];
    const personal = pat.filter((m) => m.personal).map((m) => m.address);
    expect(personal.length).toBeGreaterThanOrEqual(2); // her personal mailbox and the Gmail she connected, at least
    for (const who of [w.member, w.nobody]) {
      for (const path of MEMBER_LISTS) {
        const r = await who.c.get(path);
        expect(r.status, path).toBe(200);
        const text = JSON.stringify(r.body).toLowerCase();
        for (const a of personal) expect(text.includes(a.toLowerCase()), `${path} carries ${a}`).toBe(false);
      }
    }
    // A read share is access Pat gave: Rae sees that one mailbox in her list.
    const rae = (await w.dRead.c.get("/api/mailboxes")).body.mailboxes as { id: string }[];
    expect(rae.map((m) => m.id)).toContain(w.boxes.personal);
  }, 180_000);
});

describe("MB-367: the recent activity a member sees carries no mailbox address", () => {
  it("drops address keys and any value holding an address, keeps the rest", () => {
    const row = { ip: "1.2.3.4", actorEmail: "pat@acme.io", metadata: { address: "pat@gmail.com", provider: "gmail", destinations: ["a@b.co"], replyTo: "r@acme.io", note: "sent to x@y.co", count: 3 } };
    expect(memberSafeAudit(row)).toEqual({ ip: null, actorEmail: "pat@acme.io", metadata: { provider: "gmail", count: 3 } });
  });

  it("drops an address nested in an object or list under any key, keeping the rest of that object (F7)", () => {
    const row = { ip: null, actorEmail: null, metadata: { before: { name: "Pat", forward: "pat@gmail.com" }, people: [{ who: "x@y.co" }], plan: { from: "free", to: "pro" } } };
    expect(memberSafeAudit(row).metadata).toEqual({ before: { name: "Pat" }, plan: { from: "free", to: "pro" } });
  });

  it("keeps numbers and booleans under any key: a send's recipient count stays, its recipients go (F7)", () => {
    const row = { ip: "1.2.3.4", actorEmail: null, metadata: { recipients: 3, to: ["a@b.co"], replyTo: "r@acme.io", ok: true, nested: { recipient: "x@y.co", count: 2 }, subject: "Private" } };
    expect(memberSafeAudit(row).metadata).toEqual({ recipients: 3, ok: true, nested: { count: 2 } });
  });
});
