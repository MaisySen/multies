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
    // W5 (round 2): "Pat" sits beside an address in the same object, so it is that address's display name and goes too;
    // the object left with nothing in it goes. Changed deliberately (it was kept before).
    expect(memberSafeAudit(row).metadata).toEqual({ plan: { from: "free", to: "pro" } });
  });

  it("W5: percent encoded, quoted and fullwidth addresses go; a version string like pkg@1.2.3 stays", () => {
    const row = { ip: null, actorEmail: null, metadata: {
      link: "https://x.example/u?e=pat%40gmail.com", quoted: "\"pat smith\"@example.com", wide: "pat＠gmail.com", pkg: "left-pad@1.2.3", plain: "hello",
    } };
    expect(memberSafeAudit(row).metadata).toEqual({ pkg: "left-pad@1.2.3", plain: "hello" });
  });

  it("Wave 1 review V13: an address on a Unicode top level domain goes; digits-only labels still don't count", () => {
    const row = { ip: null, actorEmail: null, metadata: { a: "x@primer.рф", b: "मेल@उदाहरण.भारत", c: "note for y@shop.中国 today", pkg: "left-pad@1.2.3", v: "lib@2.0.10" } };
    expect(memberSafeAudit(row).metadata).toEqual({ pkg: "left-pad@1.2.3", v: "lib@2.0.10" });
  });

  it("W5: under a secret key (token, ip, invitation) every value goes, numbers too; an address key keeps a count", () => {
    const row = { ip: "1.2.3.4", actorEmail: null, metadata: { token: 123456, ip: 3232235777, invitationId: 42, userAgent: true, recipients: 3, emailCount: 2, ok: true } };
    expect(memberSafeAudit(row).metadata).toEqual({ recipients: 3, emailCount: 2, ok: true });
  });

  it("W5: a recipient's display name beside its address goes; the object's other fields stay", () => {
    const row = { ip: null, actorEmail: null, metadata: { to: [{ name: "Grace Hopper", address: "grace@navy.mil", kind: "to" }], sender: { displayName: "Pat", email: "pat@acme.io", role: "member" }, team: { name: "Ops", size: 4 } } };
    expect(memberSafeAudit(row).metadata).toEqual({ to: [{ kind: "to" }], sender: { role: "member" }, team: { name: "Ops", size: 4 } });
  });

  it("keeps numbers and booleans under any key: a send's recipient count stays, its recipients go (F7)", () => {
    const row = { ip: "1.2.3.4", actorEmail: null, metadata: { recipients: 3, to: ["a@b.co"], replyTo: "r@acme.io", ok: true, nested: { recipient: "x@y.co", count: 2 }, subject: "Private" } };
    expect(memberSafeAudit(row).metadata).toEqual({ recipients: 3, ok: true, nested: { count: 2 } });
  });
});
