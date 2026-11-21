/**
 * OPS1 feature flags: the request side of services/console/flags.ts. Route gates ask `flagOn(c, key)` for the value
 * that applies to this request's workspace. The overrides are already loaded by the /api/* middleware in app.ts.
 *
 * - After requireAuth (c.var.auth set): the signed in workspace's value.
 * - An API key request (c.var.apiKeyOrg): that workspace's value.
 * - Before the session is read (a router's `.use("*")` gate): the platform wide value, unless an operator gave some
 *   workspace a different value for this flag. Only then the session is read here (resolveAuthFor, which also runs
 *   the impersonation check requireAuth runs) to find the workspace. With no session, the platform wide value.
 *
 * With no override rows every answer is the env default, exactly as the `deps.config` checks it replaces.
 */
import type { Context } from "hono";
import type { AppEnv, AuthContext } from "../../context";
import { resolveAuthFor } from "../../auth/guards";
import { eq } from "drizzle-orm";
import { forms } from "../../db/schema";
import { featureOn, featureVariesByWorkspace, loadFlagOverridesSafe } from "./flags";
import type { FlagKey } from "@/shared/feature-flags";

type Vars = { auth?: AuthContext; apiKeyOrg?: string };

/** The workspace this request acts in, when already known (no session read). */
export function requestOrgId(c: Context<AppEnv>): string | undefined {
  const v = c.var as Vars;
  return v.auth?.orgId ?? v.apiKeyOrg;
}

/** Synchronous: the value for the request's known workspace, else the platform wide value. */
export function flagOnNow(c: Context<AppEnv>, key: FlagKey): boolean {
  return featureOn(c.var.deps, key, requestOrgId(c));
}

/**
 * For a public route (no session: a link with a token): the value for the workspace that owns the linked item.
 * `ownerOf` runs only when an operator gave some workspace a different value for this flag; otherwise, and when the
 * owner is not found, the platform wide value (the visitor's own session never decides it).
 */
export async function flagOnForOwner(c: Context<AppEnv>, key: FlagKey, ownerOf: () => Promise<string | null | undefined>): Promise<boolean> {
  const deps = c.var.deps;
  if (!featureVariesByWorkspace(deps, key)) return featureOn(deps, key);
  return featureOn(deps, key, (await ownerOf()) ?? undefined);
}

/** R93 /forms-embed.js (not under /api): served while Forms plus is on for the platform or for some workspace. */
export async function formsPlusAnywhere(c: Context<AppEnv>): Promise<boolean> {
  await loadFlagOverridesSafe(c.var.deps);
  return featureOn(c.var.deps, "formsPlus") || featureVariesByWorkspace(c.var.deps, "formsPlus");
}

/** R93 /f/<slug>/embed (not under /api): framable only while Forms plus is on for the form's workspace. */
export async function formsPlusForEmbed(c: Context<AppEnv>): Promise<boolean> {
  await loadFlagOverridesSafe(c.var.deps);
  const slug = /^\/f\/([A-Za-z0-9_-]{1,64})\//.exec(c.req.path)?.[1]?.toLowerCase() ?? "";
  return flagOnForOwner(c, "formsPlus", async () =>
    (await c.var.deps.db.select({ orgId: forms.orgId }).from(forms).where(eq(forms.slug, slug)).get())?.orgId);
}

/** The value for this request's workspace, reading the session first only when the flag differs by workspace. */
export async function flagOn(c: Context<AppEnv>, key: FlagKey): Promise<boolean> {
  const deps = c.var.deps;
  const known = requestOrgId(c);
  if (known || !featureVariesByWorkspace(deps, key)) return featureOn(deps, key, known);
  // A refused session (for example an impersonation block) counts as none here; requireAuth answers it after the gate.
  const auth = await resolveAuthFor(deps, c.req.raw.headers, { method: c.req.method, path: c.req.path }).catch((): AuthContext | null => null);
  return featureOn(deps, key, auth?.orgId);
}
