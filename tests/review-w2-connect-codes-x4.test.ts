/**
 * Wave 2 review X4: the per address code cap (Wave 1 review V5) was global, so an attacker in another workspace could
 * use up an address's five codes every day and lock its real owner out. It now counts per (address, workspace) and
 * per (address, person), five a day each. (The cap of 20 a day across everyone it had is replaced in Wave 3 review Y7.)
 */
import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { CODES_PER_ADDRESS_PERSON_DAY, CODES_PER_ADDRESS_WORKSPACE_DAY, claimCodeSend } from "@/server/services/connect";

const ADDR = "owner@victim.example";

describe("X4: connect code caps per workspace and per person", () => {
  it("five a day per workspace and per person, case blind", async () => {
    expect([CODES_PER_ADDRESS_WORKSPACE_DAY, CODES_PER_ADDRESS_PERSON_DAY]).toEqual([5, 5]);
    const { deps } = await makeTestApp();
    for (let i = 0; i < 5; i++) await claimCodeSend(deps, { email: i % 2 ? ADDR.toUpperCase() : ADDR, orgId: "org_a", userId: `usr_${i}`, connectionId: null });
    await expect(claimCodeSend(deps, { email: ADDR, orgId: "org_a", userId: "usr_9", connectionId: null })).rejects.toMatchObject({ status: 429 });
    // Another workspace is not affected.
    await claimCodeSend(deps, { email: ADDR, orgId: "org_b", userId: "usr_b", connectionId: null });
    // One person across workspaces: five, then refused. Wave 3 review Y7: within the day's five workspaces for the address.
    for (let i = 0; i < 3; i++) await claimCodeSend(deps, { email: ADDR, orgId: `org_p${i}`, userId: "usr_b", connectionId: null });
    await claimCodeSend(deps, { email: ADDR, orgId: "org_b", userId: "usr_b", connectionId: null });
    await expect(claimCodeSend(deps, { email: ADDR, orgId: "org_p0", userId: "usr_b", connectionId: null })).rejects.toMatchObject({ status: 429 });
    // A new day starts again.
    const real = deps.now;
    deps.now = () => new Date(real().getTime() + 24 * 3_600_000 + 1);
    try { await claimCodeSend(deps, { email: ADDR, orgId: "org_a", userId: "usr_0", connectionId: null }); } finally { deps.now = real; }
  });
  // Wave 3 review Y7 (deliberate change): the cap of 20 codes across everyone, with every workspace's first code let
  // through, is replaced by five distinct workspaces a day per address: tests/connect-codes-y7.test.ts.
});
