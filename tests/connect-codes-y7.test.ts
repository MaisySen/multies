/**
 * Wave 3 review Y7: the X4 code caps let many workspaces past the 20 a day cap (each one's first code always went out),
 * and once that cap was used up the real owner's workspace couldn't resend its code. Now: at most 5 distinct
 * workspaces a day may ask for codes to one address, and a workspace that may ask gets up to 5 codes a day for it
 * (resends included) whatever other workspaces do.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { CODES_PER_ADDRESS_WORKSPACE_DAY, WORKSPACES_PER_ADDRESS_DAY, claimCodeSend } from "@/server/services/connect";

const ADDR = "owner@victim.example";

describe("Y7: connect code caps", () => {
  it("at most 5 distinct workspaces a day get a place (for resends) per address; a 6th is refused, and a new day starts again", async () => {
    // Review Z4: a workspace's first code needs no place, so each workspace here asks twice (its resend takes a place).
    expect([WORKSPACES_PER_ADDRESS_DAY, CODES_PER_ADDRESS_WORKSPACE_DAY]).toEqual([5, 5]);
    const { deps } = await makeTestApp();
    for (let w = 0; w < 5; w++) for (let i = 0; i < 2; i++) await claimCodeSend(deps, { email: ADDR, orgId: `org_${w}`, userId: `usr_${w}_${i}`, connectionId: null });
    await claimCodeSend(deps, { email: ADDR.toUpperCase(), orgId: "org_6", userId: "usr_6", connectionId: null });
    await expect(claimCodeSend(deps, { email: ADDR.toUpperCase(), orgId: "org_6", userId: "usr_6a", connectionId: null })).rejects.toMatchObject({ status: 429 });
    // Refused again: a refused workspace never gets a place by asking twice.
    await expect(claimCodeSend(deps, { email: ADDR, orgId: "org_6", userId: "usr_6b", connectionId: null })).rejects.toMatchObject({ status: 429 });
    const real = deps.now;
    deps.now = () => new Date(real().getTime() + 24 * 3_600_000 + 1);
    try { await claimCodeSend(deps, { email: ADDR, orgId: "org_6", userId: "usr_6", connectionId: null }); } finally { deps.now = real; }
  });

  it("a workspace with a place gets its 5 codes (resends included) however many other workspaces asked", async () => {
    const { deps } = await makeTestApp();
    // The real owner asks first, then four other workspaces use up their codes (25 in all, past the old cap of 20).
    await claimCodeSend(deps, { email: ADDR, orgId: "org_owner", userId: "usr_owner", connectionId: "mcn_owner" });
    for (let w = 0; w < 4; w++) for (let i = 0; i < 5; i++) await claimCodeSend(deps, { email: ADDR, orgId: `org_x${w}`, userId: `usr_${w}_${i}`, connectionId: null });
    // The owner's resends still go out, up to five a day in all.
    for (let i = 0; i < 4; i++) await claimCodeSend(deps, { email: ADDR, orgId: "org_owner", userId: "usr_owner", connectionId: "mcn_owner" });
    await expect(claimCodeSend(deps, { email: ADDR, orgId: "org_owner", userId: "usr_owner2", connectionId: "mcn_owner2" })).rejects.toMatchObject({ status: 429 });
  });
});
