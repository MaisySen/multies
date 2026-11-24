/**
 * Wave 2 review X4: the per address code cap (Wave 1 review V5) was global, so an attacker in another workspace could
 * use up an address's five codes every day and lock its real owner out. It now counts per (address, workspace) and
 * per (address, person), five a day each, with a cap of 20 a day across everyone as abuse protection; the first code
 * of the day for a workspace with nothing waiting for that address always goes out.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { CODES_PER_ADDRESS_DAY, CODES_PER_ADDRESS_PERSON_DAY, CODES_PER_ADDRESS_WORKSPACE_DAY, claimCodeSend } from "@/server/services/connect";
import { domains, mailboxes, mailConnections, organizations } from "@/server/db/schema";

const ADDR = "owner@victim.example";

describe("X4: connect code caps per workspace and per person", () => {
  it("five a day per workspace and per person, case blind", async () => {
    expect([CODES_PER_ADDRESS_WORKSPACE_DAY, CODES_PER_ADDRESS_PERSON_DAY, CODES_PER_ADDRESS_DAY]).toEqual([5, 5, 20]);
    const { deps } = await makeTestApp();
    for (let i = 0; i < 5; i++) await claimCodeSend(deps, { email: i % 2 ? ADDR.toUpperCase() : ADDR, orgId: "org_a", userId: `usr_${i}`, connectionId: null });
    await expect(claimCodeSend(deps, { email: ADDR, orgId: "org_a", userId: "usr_9", connectionId: null })).rejects.toMatchObject({ status: 429 });
    // Another workspace is not affected.
    await claimCodeSend(deps, { email: ADDR, orgId: "org_b", userId: "usr_b", connectionId: null });
    // One person across workspaces: five, then refused even in a fresh workspace.
    for (let i = 0; i < 4; i++) await claimCodeSend(deps, { email: ADDR, orgId: `org_p${i}`, userId: "usr_b", connectionId: null });
    await expect(claimCodeSend(deps, { email: ADDR, orgId: "org_p9", userId: "usr_b", connectionId: null })).rejects.toMatchObject({ status: 429 });
    // A new day starts again.
    const real = deps.now;
    deps.now = () => new Date(real().getTime() + 24 * 3_600_000 + 1);
    try { await claimCodeSend(deps, { email: ADDR, orgId: "org_a", userId: "usr_0", connectionId: null }); } finally { deps.now = real; }
  });

  it("20 a day across everyone, except the first code for a workspace with nothing waiting", async () => {
    const { deps, db } = await makeTestApp();
    // 20 codes from four workspaces (five each, different people).
    for (let w = 0; w < 4; w++) for (let i = 0; i < 5; i++) await claimCodeSend(deps, { email: ADDR, orgId: `org_w${w}`, userId: `usr_${w}_${i}`, connectionId: null });
    // A fresh workspace with nothing waiting: its first code goes out.
    await claimCodeSend(deps, { email: ADDR, orgId: "org_new", userId: "usr_new", connectionId: null });
    // Its second is over the global cap.
    await expect(claimCodeSend(deps, { email: ADDR, orgId: "org_new", userId: "usr_new2", connectionId: null })).rejects.toMatchObject({ status: 429 });
    // A workspace whose first code today it is, but with a connection already waiting on the address: global cap applies.
    const orgId = "org_waiting";
    await db.insert(organizations).values({ id: orgId, name: "W", slug: "w-x4", createdAt: new Date() } as never);
    await db.insert(domains).values({ id: "dom_x4", orgId, name: "x4.example", status: "verified", verificationToken: "tok", dkimSelector: "s", dkimPublicKey: "p", dkimPrivateKeyEnc: "k" } as never);
    await db.insert(mailboxes).values({ id: "mbx_x4", orgId, domainId: "dom_x4", localPart: "owner", address: ADDR, displayName: "O", quotaMb: 10 });
    await db.insert(mailConnections).values({ id: "mcn_x4", orgId, mailboxId: "mbx_x4", provider: "custom", email: ADDR, username: ADDR, imapHost: "i", imapPort: 993, imapSecurity: "tls", smtpHost: "s", smtpPort: 465, smtpSecurity: "tls", authKind: "password", secretEnc: "x", status: "verifying" } as never);
    await expect(claimCodeSend(deps, { email: ADDR, orgId, userId: "usr_w", connectionId: "mcn_x4" })).rejects.toMatchObject({ status: 429 });
  });
});
