/**
 * PRIV1b (ML2): an idle cron pass writes nothing for the access log prune and the foreign app password sweep. The
 * prune mark used to be rewritten every pass (the cutoff moves with the clock), two metered rows each 15 minutes.
 */
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { meter } from "./d1-meter";
import { appSettings, mailboxAccessLog, mailboxes } from "@/server/db/schema";
import { OPENS_PRUNED_KEY, pruneMailboxOpens, runMaintenance } from "@/server/services/maintenance";
import { sweepForeignAppPasswords } from "@/server/services/mailserver";

const DAY = 86_400_000;
const MIN = 60_000;

describe("PRIV1b: idle cron passes write nothing for the prune and the sweep", () => {
  it("two passes in a row with nothing to do write nothing; old opens are still deleted and share rows kept", async () => {
    const ctx = await makeTestApp();
    const u = new Client(ctx.app);
    await u.signup("owner@acme.test", "Olive Owner");
    const dom = (await u.post("/api/domains", { name: "help.test" })).body.domain.id as string;
    const mailboxId = (await u.post("/api/mailboxes", { domainId: dom, localPart: "help", displayName: "Help" })).body.mailbox.id as string;
    let t = Date.now();
    ctx.deps.now = () => new Date(t);
    await runMaintenance(ctx.deps); // the first pass ever sets the mark
    const take = meter(ctx.db);
    for (let i = 0; i < 2; i++) {
      t += 15 * MIN;
      take();
      await runMaintenance(ctx.deps);
      const tables = take.byTable();
      expect(tables.app_settings ?? 0, `pass ${i + 1}`).toBe(0);
      expect(tables.mailbox_access_log ?? 0, `pass ${i + 1}`).toBe(0);
      expect(tables.app_passwords ?? 0, `pass ${i + 1}`).toBe(0);
      t += 15 * MIN;
      take();
      expect(await pruneMailboxOpens(ctx.deps)).toBe(0);
      expect(await sweepForeignAppPasswords(ctx.deps)).toBe(0);
      expect(take(), `steps ${i + 1}`).toBe(0);
    }

    // A pass with old "opened" rows still deletes them (and moves the mark); share rows and recent opens stay.
    const orgId = (await ctx.db.select({ orgId: mailboxes.orgId }).from(mailboxes).where(eq(mailboxes.id, mailboxId)).get())!.orgId;
    const row = (id: string, action: string, ageMs: number) => ({ id: `mal_cw${id}`, orgId, mailboxId, actorUserId: null, actorEmail: null, action, targetId: null, device: "web", createdAt: new Date(t - ageMs) });
    // Opens are logged at the time they happen, so a row ages past the cutoff after the mark was set: here, 401 days
    // old once the clock moves 2 days on.
    await ctx.db.insert(mailboxAccessLog).values([row("old", "opened_thread", 399 * DAY), row("share", "share_granted", 399 * DAY), row("new", "opened_mailbox", DAY)]);
    t += 2 * DAY;
    const before = Number((await ctx.db.select().from(appSettings).where(eq(appSettings.key, OPENS_PRUNED_KEY)).get())!.value);
    await runMaintenance(ctx.deps);
    const left = (await ctx.db.select({ id: mailboxAccessLog.id }).from(mailboxAccessLog).where(eq(mailboxAccessLog.orgId, orgId))).map((r) => r.id).filter((id) => id.startsWith("mal_cw")).sort();
    expect(left).toEqual(["mal_cwnew", "mal_cwshare"]);
    const after = Number((await ctx.db.select().from(appSettings).where(eq(appSettings.key, OPENS_PRUNED_KEY)).get())!.value);
    expect(after).toBe(t - 400 * DAY);
    expect(after).toBeGreaterThan(before);
  }, 60_000);
});
