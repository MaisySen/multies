/**
 * OPS1: legal holds do not depend on an operator switch.
 * (a) Enforcement (deletes refused, import Undo kept) applies whenever an active hold exists, whatever mailArchive says.
 * (b) The flag only controls the archive's routes (cases, holds, policy).
 * (c) The console refuses an override that would leave mailArchive off for a workspace with an active hold.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client, makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";
import { featureFlagOverrides, mailLegalHolds, organizations } from "@/server/db/schema";
import { assertMailboxNotHeld, assertNotHeld, heldScope } from "@/server/services/mail/archive-r111";
import { FlagError, clearFlagOverride, invalidateFlagOverrides, loadFlagOverrides, setFlagOverride } from "@/server/services/console/flags";

afterEach(() => invalidateFlagOverrides());

const BOX = "mbx_held_test";
const orgIdOf = async (ctx: Awaited<ReturnType<typeof makeTestApp>>, name: string) =>
  (await ctx.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, name)).get())!.id;

async function hold(ctx: Awaited<ReturnType<typeof makeTestApp>>, orgId: string, released = false) {
  const id = `hold_${Math.random().toString(36).slice(2, 10)}`;
  await ctx.db.insert(mailLegalHolds).values({ id, orgId, kind: "mailbox", targetId: BOX, name: "Matter 12", releasedAt: released ? new Date() : null });
  return id;
}

describe("(a) enforcement follows the hold rows, not the flag", () => {
  for (const [name, env] of [["env off, no override", {}], ["env on, workspace override off", { MAIL_ARCHIVE_R111: "on" }]] as const) {
    it(`refuses deleting held mail and keeps Undo from removing it (${name})`, async () => {
      const ctx = await makeTestApp(env as Record<string, string>);
      const c = new Client(ctx.app);
      await c.signup("hold-a@example.com", "Hana", "Hold A");
      const orgA = await orgIdOf(ctx, "Hold A");
      await hold(ctx, orgA);
      // The console refuses turning it off over a hold (c); an old row or a direct write still could.
      if ("MAIL_ARCHIVE_R111" in env) await ctx.db.insert(featureFlagOverrides).values({ key: "mailArchive", scopeId: orgA, value: "off", locked: false, updatedAt: new Date() });
      invalidateFlagOverrides();
      await loadFlagOverrides(ctx.deps);
      await expect(assertMailboxNotHeld(ctx.deps, orgA, BOX)).rejects.toMatchObject({ status: 409, code: "legal_hold" });
      await expect(assertNotHeld(ctx.deps, orgA, [{ mailboxId: BOX, folder: "inbox" }])).rejects.toMatchObject({ status: 409, code: "legal_hold" });
      expect((await heldScope(ctx.deps, orgA)).mailboxIds).toContain(BOX);
      // (b) the archive's own routes still follow the flag: off here, so 404.
      expect((await c.get("/api/mail-archive/holds")).status).toBe(404);
    }, 60_000);
  }

  it("refuses nothing with no active hold (the env off behaviour)", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("hold-b@example.com", "Hugo", "Hold B");
    const orgB = await orgIdOf(ctx, "Hold B");
    await hold(ctx, orgB, true); // released
    await expect(assertMailboxNotHeld(ctx.deps, orgB, BOX)).resolves.toBeUndefined();
    await expect(assertNotHeld(ctx.deps, orgB, [{ mailboxId: BOX, folder: "inbox" }])).resolves.toBeUndefined();
  }, 60_000);
});

describe("(c) the console keeps mailArchive on where a hold is active", () => {
  it("refuses a workspace off, a global off, a locked global off and clearing the workspace's on, until the hold is released", async () => {
    const ctx = await makeTestApp(); // env off: the held workspace has the archive through its own override
    const { c: owner } = await signUpAs(ctx, "own@ops.test", "admin", "Owner HQ");
    const c = new Client(ctx.app);
    await c.signup("hold-c@example.com", "Ida", "Hold C");
    await new Client(ctx.app).signup("hold-d@example.com", "Dan", "Hold D");
    const orgC = await orgIdOf(ctx, "Hold C");
    const orgD = await orgIdOf(ctx, "Hold D");
    await setFlagOverride(ctx.deps, { key: "mailArchive", scopeId: orgC, value: true, updatedBy: null });
    const holdId = await hold(ctx, orgC);

    const refused = async (p: Promise<unknown>) => { await expect(p).rejects.toBeInstanceOf(FlagError); await expect(p).rejects.toMatchObject({ code: "legal_hold_active", message: "This workspace has an active legal hold. Release the hold first." }); };
    await refused(setFlagOverride(ctx.deps, { key: "mailArchive", scopeId: orgC, value: false, updatedBy: null }));
    await refused(clearFlagOverride(ctx.deps, { key: "mailArchive", scopeId: orgC }));
    await refused(setFlagOverride(ctx.deps, { key: "mailArchive", scopeId: "", value: false, locked: true, updatedBy: null }));
    // A global off that leaves the held workspace on (its own override) is allowed; another workspace may go off.
    await setFlagOverride(ctx.deps, { key: "mailArchive", scopeId: "", value: false, updatedBy: null });
    await setFlagOverride(ctx.deps, { key: "mailArchive", scopeId: orgD, value: false, updatedBy: null });

    // The route answers 409 with the typed code and the plain message.
    const res = await owner.call("PUT", `/api/console/flags/mailArchive/workspaces/${orgC}`, { value: false, reason: "Customer asked to turn it off" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "legal_hold_active", message: "This workspace has an active legal hold. Release the hold first." });

    // Released: allowed.
    await ctx.db.update(mailLegalHolds).set({ releasedAt: new Date() }).where(eq(mailLegalHolds.id, holdId));
    await setFlagOverride(ctx.deps, { key: "mailArchive", scopeId: orgC, value: false, updatedBy: null });
  }, 120_000);

  it("refuses a global off while a workspace that has the archive from the env has an active hold", async () => {
    const ctx = await makeTestApp({ MAIL_ARCHIVE_R111: "on" });
    const c = new Client(ctx.app);
    await c.signup("hold-e@example.com", "Eve", "Hold E");
    await hold(ctx, await orgIdOf(ctx, "Hold E"));
    await expect(setFlagOverride(ctx.deps, { key: "mailArchive", scopeId: "", value: false, updatedBy: null })).rejects.toMatchObject({ code: "legal_hold_active" });
    // Other flags are not affected by holds.
    await setFlagOverride(ctx.deps, { key: "crmTimeline", scopeId: "", value: false, updatedBy: null });
  }, 60_000);
});
