/**
 * Review Z4: Y7 let five attacker workspaces take all of a day's places for an address, after which the real owner's
 * workspace got no code at all. Now a workspace's first code for an address each day always goes out and takes no
 * place; the five places are for further codes (resends). The per person cap is checked before a place is taken, and a
 * place taken by a request that is then refused is given back.
 */
import { describe, it, expect } from "vitest";
import { makeTestApp } from "./helpers";
import { CODES_PER_ADDRESS_PERSON_DAY, CODES_PER_ADDRESS_WORKSPACE_DAY, WORKSPACES_PER_ADDRESS_DAY, claimCodeSend } from "@/server/services/connect";

const ADDR = "owner@victim.example";
const send = (deps: Parameters<typeof claimCodeSend>[0], orgId: string, userId: string, connectionId: string | null = null) => claimCodeSend(deps, { email: ADDR, orgId, userId, connectionId });

describe("Z4: no lockout from the workspace places", () => {
  it("five attacker workspaces using every place don't stop the owner's first code", async () => {
    const { deps } = await makeTestApp();
    for (let w = 0; w < WORKSPACES_PER_ADDRESS_DAY; w++) for (let i = 0; i < 2; i++) await send(deps, `org_x${w}`, `usr_x${w}`);
    // A sixth attacker workspace still gets its first code, but no resend: the places are taken.
    await send(deps, "org_x6", "usr_x6");
    await expect(send(deps, "org_x6", "usr_x6")).rejects.toMatchObject({ status: 429 });
    // The owner's first code goes out.
    await send(deps, "org_owner", "usr_owner", "mcn_owner");
  });

  it("flood bound: one person gets at most their daily codes across workspaces; a workspace without a place gets one", async () => {
    const { deps } = await makeTestApp();
    let sent = 0;
    for (let w = 0; w < 12; w++) { try { await send(deps, `org_f${w}`, "usr_flood"); sent++; } catch (e) { expect(e).toMatchObject({ status: 429 }); } }
    expect(sent).toBe(CODES_PER_ADDRESS_PERSON_DAY);
    // A workspace's own cap still holds with a place.
    const { deps: d2 } = await makeTestApp();
    for (let i = 0; i < CODES_PER_ADDRESS_WORKSPACE_DAY; i++) await send(d2, "org_one", `usr_one${i}`);
    await expect(send(d2, "org_one", "usr_one_more")).rejects.toMatchObject({ status: 429 });
  });

  it("a refused request gives its place back, and the person cap is checked before a place is taken", async () => {
    const { deps } = await makeTestApp();
    // One person uses up their codes (one place taken by their resend in org_p).
    await send(deps, "org_p", "usr_p");
    for (let i = 1; i < CODES_PER_ADDRESS_PERSON_DAY; i++) await send(deps, `org_p${i}`, "usr_p");
    // Their next asks, in new workspaces' resends, are refused by the person cap and take no place.
    for (let w = 0; w < 6; w++) await expect(send(deps, `org_p${w + 1}`, "usr_p")).rejects.toMatchObject({ status: 429 });
    // Connection cap refusals give the place back too.
    const { deps: d3 } = await makeTestApp();
    await send(d3, "org_c", "usr_c0", "mcn_c");
    for (let i = 1; i < 5; i++) await send(d3, `org_c`, `usr_c${i}`, "mcn_c");
    await expect(send(d3, "org_c2", "usr_c9", "mcn_c")).rejects.toMatchObject({ status: 429 });
    await expect(send(d3, "org_c2", "usr_c9b", "mcn_c")).rejects.toMatchObject({ status: 429 });
    // No place went to a refused request: four more workspaces take the other places for a resend, and that is all.
    for (let w = 0; w < WORKSPACES_PER_ADDRESS_DAY - 1; w++) { await send(d3, `org_r${w}`, `usr_r${w}`); await send(d3, `org_r${w}`, `usr_r${w}b`); }
    await send(d3, "org_r9", "usr_r9");
    await expect(send(d3, "org_r9", "usr_r9b")).rejects.toMatchObject({ status: 429 });
    for (let w = 0; w < WORKSPACES_PER_ADDRESS_DAY; w++) { await send(deps, `org_q${w}`, `usr_q${w}`); await send(deps, `org_q${w}`, `usr_q${w}b`); }
  });
});
