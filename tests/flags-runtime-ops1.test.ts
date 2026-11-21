/**
 * OPS1 feature flags, the honesty rule: every flag the operator console lets an operator change (runtime true) really
 * changes behaviour. Each runtime flag is flipped by an override and an observable answer changes: /api/config (global),
 * /api/account/me flags (workspace overrides), or a route or service answer for flags with no client name. Route level
 * gates are checked per workspace: on for one workspace only works there; off for one workspace answers exactly what
 * the route answers today with the env flag off (same status and error code).
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client, makeTestApp } from "./helpers";
import { featureFlagOverrides } from "@/server/db/schema";
import { invalidateFlagOverrides, loadFlagOverrides, setFlagOverride } from "@/server/services/console/flags";
import { keyFallbackOn } from "@/server/services/ai/keys";
import { splitTabs } from "@/server/services/mail/splits";
import type { DB } from "@/server/db";
import { FEATURE_FLAGS, type FlagDef } from "@/shared/feature-flags";

const DEFS = FEATURE_FLAGS as readonly FlagDef[];
const RUNTIME = DEFS.filter((d) => d.runtime);
const LIVEKIT = { LIVEKIT_URL: "wss://video.example.test", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" };
/** Every set-at-deploy flag on (their env), so the runtime flags that need one of them can show. */
const BOOT_ON = Object.fromEntries(DEFS.filter((d) => !d.runtime).map((d) => [d.env, "true"]));

afterEach(() => invalidateFlagOverrides());

type Ctx = Awaited<ReturnType<typeof makeTestApp>>;

async function world(env: Record<string, string>) {
  const ctx = await makeTestApp(env);
  const a = new Client(ctx.app);
  const b = new Client(ctx.app);
  await a.signup("rt-owner-a@example.com", "Ada", "Runtime A");
  await b.signup("rt-owner-b@example.com", "Bea", "Runtime B");
  const orgA = (await a.get("/api/account/me")).body.organization.id as string;
  const orgB = (await b.get("/api/account/me")).body.organization.id as string;
  return { ctx, a, b, orgA, orgB };
}

const set = (ctx: Ctx, key: string, scopeId: string, value: boolean) => setFlagOverride(ctx.deps, { key, scopeId, value, updatedBy: null });
async function clear(db: DB) { await db.delete(featureFlagOverrides); invalidateFlagOverrides(); }

describe("every runtime flag with a client name", () => {
  it("a global override decides its /api/config value", async () => {
    const { ctx, a } = await world({ ...LIVEKIT, ...BOOT_ON });
    for (const def of RUNTIME.filter((d) => d.clientKey)) {
      await clear(ctx.db);
      for (const r of def.requires ?? []) if (DEFS.find((d) => d.key === r)?.runtime) await set(ctx, r, "", true);
      await set(ctx, def.key, "", true);
      expect((await a.get("/api/config")).body[def.clientKey!], `${def.key} on`).toBe(true);
      await set(ctx, def.key, "", false);
      expect((await a.get("/api/config")).body[def.clientKey!], `${def.key} off`).toBe(false);
    }
  }, 120_000);

  it("a workspace override shows in that workspace's me.flags only (workspace flags)", async () => {
    const { ctx, a, b, orgA } = await world({ ...LIVEKIT, ...BOOT_ON });
    for (const def of RUNTIME.filter((d) => d.clientKey && d.scope === "workspace")) {
      await clear(ctx.db);
      for (const r of def.requires ?? []) if (DEFS.find((d) => d.key === r)?.runtime) await set(ctx, r, "", true);
      const global = (await a.get("/api/config")).body[def.clientKey!] as boolean;
      await set(ctx, def.key, orgA, !global);
      expect((await a.get("/api/account/me")).body.flags, def.key).toEqual({ [def.clientKey!]: !global });
      expect((await b.get("/api/account/me")).body.flags, def.key).toEqual({});
    }
  }, 120_000);
});

describe("every runtime flag without a client name changes a server answer", () => {
  /** Observes the flag through a route or service; returns something that differs between on and off. */
  const PROBES: Record<string, (w: Awaited<ReturnType<typeof world>>) => Promise<unknown>> = {
    mailConnect: async ({ a }) => (await a.get("/api/connections")).body.enabled,
    mailLive: async ({ a }) => (await a.post("/api/connections/live", {})).body.live,
    pushNotifications: async ({ a }) => (await a.get("/api/push/devices")).body.enabled,
    notificationCentre: async ({ a }) => "delivery" in ((await a.get("/api/notifications/settings")).body ?? {}),
    clientPortal: async ({ a }) => (await a.get("/api/portals")).status,
    aiKeyFallback: async ({ ctx }) => { await loadFlagOverrides(ctx.deps); return keyFallbackOn({ ...ctx.deps, ai: {} as never }); },
    mailSplitCounts: async ({ ctx, a }) => {
      await loadFlagOverrides(ctx.deps);
      const me = (await a.get("/api/account/me")).body;
      const client = (ctx.db as unknown as { $client: { prepare: (s: string) => unknown } }).$client;
      const prepare = client.prepare.bind(client);
      let counted = 0;
      client.prepare = (s: string) => { if (/sum\(case/i.test(s)) counted++; return prepare(s); };
      try {
        await splitTabs(ctx.deps, { orgId: me.organization.id, userId: me.user.id, role: "owner" } as never, { scope: null });
      } finally { client.prepare = prepare; }
      return counted > 0;
    },
  };

  it("has a probe for each of them", () => {
    expect(RUNTIME.filter((d) => !d.clientKey).map((d) => d.key).sort()).toEqual(Object.keys(PROBES).sort());
  });

  for (const key of Object.keys(PROBES)) {
    it(`${key}: a global override changes the answer`, async () => {
      const w = await world({ CLIENT_PORTAL: "on", AI_CONNECT_AI2: "on" });
      const def = DEFS.find((d) => d.key === key)!;
      for (const r of def.requires ?? []) await set(w.ctx, r, "", true);
      await set(w.ctx, key, "", true);
      const on = await PROBES[key](w);
      await set(w.ctx, key, "", false);
      const off = await PROBES[key](w);
      expect(on, key).not.toEqual(off);
    }, 60_000);
  }
});

type Probe = { key: string; method?: "GET" | "POST"; path: string; body?: unknown; env?: Record<string, string> };
/** Route level gates in different product areas; each answers differently with its flag on and off. */
const ROUTES: Probe[] = [
  { key: "crmTimeline", path: "/api/crm/segments" },
  { key: "crmTd10", path: "/api/crm-td10/suggestions" },
  { key: "mailArchive", path: "/api/mail-archive/policy" },
  { key: "askR110", path: "/api/ask/state" },
  { key: "askTd1", path: "/api/ai-trust" },
  { key: "searchR98", path: "/api/search/index" },
  { key: "invoicesEnabled", path: "/api/invoices/settings" },
  { key: "filesPlus", path: "/api/drive/usage" },
  { key: "tasksPlus", path: "/api/time/export.csv" },
  { key: "flows", path: "/api/flows", env: { FLOWS: "off" } },
  { key: "vaultR128", path: "/api/vault/state" },
  { key: "peopleR126", path: "/api/people/staff" },
  { key: "inboxTd6", path: "/api/one-inbox/count" },
  { key: "tablesR125", path: "/api/tables" },
  { key: "translateR116", method: "POST", path: "/api/translate", body: {} },
  { key: "aiConnectAi2", path: "/api/ai/oauth/openrouter/start" },
];

const shape = (r: { status: number; body: unknown }) => {
  const b = r.body as { error?: { code?: string; message?: string } } | null;
  return { status: r.status, code: b?.error?.code ?? null, message: b?.error?.message ?? null };
};

describe("route gates follow the workspace's value", () => {
  for (const p of ROUTES) {
    it(`${p.key}: ${p.method ?? "GET"} ${p.path}`, async () => {
      const w = await world(p.env ?? {});
      const call = (c: Client) => (p.method === "POST" ? c.post(p.path, p.body ?? {}) : c.get(p.path));
      const today = shape(await call(w.a)); // the env flag off, no override: today's answer
      expect(today.status, `${p.key} is off by env here`).toBe(404);
      // On for workspace A only: A gets through, B still gets today's off answer.
      await set(w.ctx, p.key, w.orgA, true);
      const aOn = shape(await call(w.a));
      expect(aOn, p.key).not.toEqual(today);
      expect(shape(await call(w.b)), p.key).toEqual(today);
      // On for the platform, off for workspace A: A answers exactly as today with the env flag off; B gets through.
      await set(w.ctx, p.key, "", true);
      await set(w.ctx, p.key, w.orgA, false);
      expect(shape(await call(w.a)), p.key).toEqual(today);
      expect(shape(await call(w.b)).status, p.key).toBe(aOn.status);
    }, 60_000);
  }
});
