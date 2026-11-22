/**
 * OPS1 security review N1: a per workspace flag override reaches the background passes. A workspace turned off while
 * the platform value is on gets no flow resume, digest or Team AI run; a workspace turned on while the platform value
 * is off does.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { signUpAs } from "./console-kit";
import { flowDigestItems, flowRuns, flows, members } from "@/server/db/schema";
import { featurePassOn, featureWorkspaces, invalidateFlagOverrides, loadFlagOverrides, setFlagOverride } from "@/server/services/console/flags";
import { resumeDueRuns, sendDueDigests } from "@/server/services/suite/flows";
import { runTeamAiPass } from "@/server/services/teamai-td8";

beforeEach(() => invalidateFlagOverrides());

async function world(env: Record<string, string>) {
  const ctx = await makeTestApp(env);
  const a = await signUpAs(ctx, "a@example.com", null, "Alpha");
  const b = await signUpAs(ctx, "b@example.com", null, "Beta");
  const orgOf = async (id: string) => (await ctx.db.select().from(members).where(eq(members.userId, id)).get())!.organizationId;
  return { ctx, alpha: await orgOf(a.id), beta: await orgOf(b.id) };
}

async function seedFlows(ctx: Awaited<ReturnType<typeof makeTestApp>>, orgId: string, tag: string) {
  const past = new Date(Date.now() - 60_000);
  await ctx.db.insert(flows).values({ id: `flw_${tag}`, orgId, name: `Flow ${tag}`, triggerKind: "manual" });
  await ctx.db.insert(flowRuns).values({ id: `frn_${tag}`, orgId, flowId: `flw_${tag}`, status: "waiting", dedupeKey: `d_${tag}`, resumeAt: past } as never);
  await ctx.db.insert(flowDigestItems).values({ id: `fdi_${tag}`, orgId, flowId: `flw_${tag}`, nodeId: "n1", title: `Item ${tag}`, sendAt: past } as never);
}

async function seedTeamAi(ctx: Awaited<ReturnType<typeof makeTestApp>>, orgId: string, tag: string) {
  await ctx.db.run(sql`insert into teamai_runs (id, org_id, kind, event_key, status, created_at) values (${`tar_${tag}`}, ${orgId}, 'routine', ${`ev_${tag}`}, 'queued', ${Date.now() - 1000})`);
}
const runStatus = async (ctx: Awaited<ReturnType<typeof makeTestApp>>, id: string) => (await ctx.db.all<{ status: string }>(sql`select status from teamai_runs where id = ${id}`))[0]?.status;

describe("N1: workspace overrides reach the background passes", () => {
  it("platform on, one workspace off: that workspace gets no flow resume, digest or Team AI run", async () => {
    const { ctx, alpha, beta } = await world({ FLOWS: "on", TEAMAI_TD8: "on" });
    await seedFlows(ctx, alpha, "a"); await seedFlows(ctx, beta, "b");
    await seedTeamAi(ctx, alpha, "a"); await seedTeamAi(ctx, beta, "b");
    for (const key of ["flows", "teamaiTd8"]) await setFlagOverride(ctx.deps, { key, scopeId: beta, value: false, updatedBy: null });
    await loadFlagOverrides(ctx.deps);
    expect(featureWorkspaces(ctx.deps, "flows")).toEqual({ all: true, except: [beta] });
    expect(await resumeDueRuns(ctx.deps)).toBe(1);
    expect((await ctx.db.select().from(flowRuns).where(eq(flowRuns.id, "frn_b")).get())!.status).toBe("waiting");
    expect((await ctx.db.select().from(flowRuns).where(eq(flowRuns.id, "frn_a")).get())!.status).not.toBe("waiting");
    await sendDueDigests(ctx.deps);
    expect((await ctx.db.select().from(flowDigestItems).where(eq(flowDigestItems.id, "fdi_a")).get())!.sentAt).toBeTruthy();
    expect((await ctx.db.select().from(flowDigestItems).where(eq(flowDigestItems.id, "fdi_b")).get())!.sentAt).toBeNull();
    await runTeamAiPass(ctx.deps);
    expect(await runStatus(ctx, "tar_a")).not.toBe("queued");
    expect(await runStatus(ctx, "tar_b")).toBe("queued");
  }, 60_000);

  it("platform off, one workspace on: only that workspace is served", async () => {
    const { ctx, alpha, beta } = await world({ FLOWS: "off", TEAMAI_TD8: "off" });
    await seedFlows(ctx, alpha, "a"); await seedFlows(ctx, beta, "b");
    await seedTeamAi(ctx, alpha, "a"); await seedTeamAi(ctx, beta, "b");
    expect(featurePassOn(ctx.deps, "flows")).toBe(false);
    for (const key of ["flows", "teamaiTd8"]) await setFlagOverride(ctx.deps, { key, scopeId: alpha, value: true, updatedBy: null });
    await loadFlagOverrides(ctx.deps);
    expect(featurePassOn(ctx.deps, "flows")).toBe(true);
    expect(await resumeDueRuns(ctx.deps)).toBe(1);
    expect((await ctx.db.select().from(flowRuns).where(eq(flowRuns.id, "frn_b")).get())!.status).toBe("waiting");
    await sendDueDigests(ctx.deps);
    expect((await ctx.db.select().from(flowDigestItems).where(eq(flowDigestItems.id, "fdi_a")).get())!.sentAt).toBeTruthy();
    expect((await ctx.db.select().from(flowDigestItems).where(eq(flowDigestItems.id, "fdi_b")).get())!.sentAt).toBeNull();
    await runTeamAiPass(ctx.deps);
    expect(await runStatus(ctx, "tar_a")).not.toBe("queued");
    expect(await runStatus(ctx, "tar_b")).toBe("queued");
  }, 60_000);

  it("platform off and no override: the passes do nothing", async () => {
    const { ctx, alpha } = await world({ FLOWS: "off", TEAMAI_TD8: "off" });
    await seedFlows(ctx, alpha, "a"); await seedTeamAi(ctx, alpha, "a");
    expect(await resumeDueRuns(ctx.deps)).toBe(0);
    expect(await sendDueDigests(ctx.deps)).toBe(0);
    expect(await runTeamAiPass(ctx.deps)).toEqual({ queued: 0, ran: 0 });
    expect(await runStatus(ctx, "tar_a")).toBe("queued");
  }, 60_000);
});
