/**
 * Wave 3 review Y8 (a): when the workspace owner makes a team mailbox at a member's sign in address that member's
 * personal mailbox, the app passwords other people made on it go, as when a share ends (unshare). Otherwise a former
 * grantee kept reading the now personal mailbox over IMAP with an app password made while it was a team mailbox.
 */
import { describe, it, expect, vi } from "vitest";
import { privacyWorld } from "./priv1a-world";
import { mailboxAccess, mailboxes } from "@/server/db/schema";
import { Client } from "./helpers";

const destroyed: [string, string][] = [];
vi.mock("@/server/services/mailserver", async (orig) => ({
  ...(await orig<typeof import("@/server/services/mailserver")>()),
  destroyForeignAppPasswords: vi.fn(async (_deps: unknown, orgId: string, mailboxId: string) => { destroyed.push([orgId, mailboxId]); return 1; }),
}));

describe("Y8 (a): converting a login address mailbox destroys other people's app passwords", () => {
  it("calls destroyForeignAppPasswords for the mailbox once it is personal", async () => {
    const w = await privacyWorld();
    const id = "mbx_y8aloginbox0001";
    const local = `kim${w.n}`;
    await w.ctx.db.insert(mailboxes).values({ id, orgId: w.orgId, domainId: w.domainId, localPart: local, address: `${local}@acme.io`, displayName: local, quotaMb: 100 });
    await w.ctx.db.insert(mailboxAccess).values({ orgId: w.orgId, userId: w.member.id, mailboxId: id });
    const inv = await w.owner.post("/api/team/invites", { email: `${local}@acme.io`, role: "member" });
    const c = new Client(w.ctx.app);
    await c.call("POST", "/api/auth/sign-up/email", { name: "Kim", email: `${local}@acme.io`, password: "a-strong-password" }, { "cf-connecting-ip": `10.79.${w.n % 250}.1` });
    c.email = `${local}@acme.io`;
    await c.call("POST", `/api/invites/${inv.body.link.split("/invite/")[1]}/accept`, {}, { "cf-connecting-ip": `10.79.${w.n % 250}.2` });
    destroyed.length = 0;
    const made = await w.owner.post(`/api/mailboxes/${id}/make-personal`, {});
    expect(made.status).toBe(200);
    expect(destroyed).toEqual([[w.orgId, id]]);
  }, 120_000);
});
