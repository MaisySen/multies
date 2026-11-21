/**
 * OPS1 announcements without polling /me: an idle signed in tab never reads /api/account/me on a timer (D1 read
 * budget); the public config is re-read every 5 minutes, and a warm /api/config does no database work at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { makeTestApp } from "./helpers";
import { ApiError } from "@/web/lib/api";
import { CONFIG_POLL_MS, ME_STALE_MS, configQueryOptions, meQueryOptions, pickAnnouncement } from "@/web/lib/queries";
import type { PublicAnnouncement } from "@/shared/announcement";
import { invalidateFlagOverrides } from "@/server/services/console/flags";
import { publishAnnouncement, resetAnnouncementCache } from "@/server/services/console/announcements";

afterEach(() => invalidateFlagOverrides());

type Interval = (q: unknown) => number | false | undefined;
const intervalOf = (opts: { refetchInterval?: unknown }, state: Record<string, unknown>) =>
  typeof opts.refetchInterval === "function" ? (opts.refetchInterval as Interval)({ state }) : opts.refetchInterval;

describe("client query options", () => {
  it("an idle signed in tab issues no periodic /api/account/me requests", () => {
    expect(intervalOf(meQueryOptions, { status: "success", error: null })).toBe(false);
    expect(intervalOf(meQueryOptions, { status: "pending", error: null })).toBe(false);
    // Signed out stops too; only an unreachable server is retried calmly (as before).
    expect(intervalOf(meQueryOptions, { status: "error", error: new ApiError(401, "unauthorized", "Sign in.") })).toBe(false);
    expect(intervalOf(meQueryOptions, { status: "error", error: new ApiError(503, "busy", "Busy.") })).toBe(15_000);
    // A refocus reads /me again only once its copy is 5 minutes old.
    expect(meQueryOptions.staleTime).toBe(ME_STALE_MS);
    expect(ME_STALE_MS).toBe(300_000);
    expect(meQueryOptions.refetchIntervalInBackground).toBeUndefined();
  });

  it("the public config is re-read every 5 minutes while visible, and never on focus", () => {
    expect(configQueryOptions.refetchInterval).toBe(CONFIG_POLL_MS);
    expect(CONFIG_POLL_MS).toBe(300_000);
    expect(configQueryOptions.staleTime).toBe(Infinity);
    expect((configQueryOptions as { refetchIntervalInBackground?: boolean }).refetchIntervalInBackground).toBeUndefined();
    // Options built into a client keep those values (no default turns polling on for /me).
    const qc = new QueryClient();
    expect(qc.defaultQueryOptions(meQueryOptions).refetchIntervalInBackground).toBeUndefined();
  });

  it("the banner takes everyone ones from the polled config and admins ones from /me", () => {
    const all = { id: "a", audience: "all" } as PublicAnnouncement;
    const admins = { id: "b", audience: "admins" } as PublicAnnouncement;
    expect(pickAnnouncement({ announcement: null }, { announcement: all })).toBe(all); // new since /me was read
    expect(pickAnnouncement({ announcement: all }, { announcement: null })).toBeNull(); // cleared since /me was read
    expect(pickAnnouncement({ announcement: admins }, { announcement: null })).toBe(admins);
    expect(pickAnnouncement({ announcement: admins }, undefined)).toBe(admins);
    expect(pickAnnouncement(undefined, { announcement: all })).toBe(all);
    expect(pickAnnouncement(undefined, undefined)).toBeNull();
  });
});

describe("/api/config database cost", () => {
  const counter = (db: unknown) => {
    const client = (db as { $client: { prepare: (s: string) => unknown } }).$client;
    const prepare = client.prepare.bind(client);
    const seen: string[] = [];
    client.prepare = (s: string) => { seen.push(s); return prepare(s); };
    return () => { const out = [...seen]; seen.length = 0; return out; };
  };

  it("cold: one read of the flag overrides and one of the announcement; warm: no statement at all", async () => {
    const ctx = await makeTestApp();
    resetAnnouncementCache(ctx.deps);
    const take = counter(ctx.db);
    expect((await ctx.app.request("/api/config")).status).toBe(200);
    const cold = take();
    expect(cold.filter((s) => /feature_flag_overrides/.test(s))).toHaveLength(1);
    expect(cold.filter((s) => /app_settings/.test(s))).toHaveLength(1);
    expect(cold.filter((s) => !/feature_flag_overrides|app_settings/.test(s))).toEqual([]);
    for (let i = 0; i < 5; i++) expect((await ctx.app.request("/api/config")).status).toBe(200);
    expect(take()).toEqual([]);
  }, 60_000);

  it("warm with an announcement stored: still no statement", async () => {
    const ctx = await makeTestApp();
    await publishAnnouncement(ctx.deps, { text: "Polling sentinel 5d2e", audience: "all" }, { userId: "op" });
    await ctx.app.request("/api/config");
    const take = counter(ctx.db);
    for (let i = 0; i < 3; i++) expect((await ctx.app.request("/api/config")).body).toBeTruthy();
    expect(take()).toEqual([]);
  }, 60_000);
});
