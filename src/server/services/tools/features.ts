import type { Context } from "hono";
import type { AppEnv, Deps } from "../../context";
import { notFound } from "../../lib/errors";
import type { ToolFeature } from "@/shared/tool-features";

/**
 * The P2 features this deployment really has: TOOLS_FEATURES, minus "index" (search inside attachments) when
 * the separate index database (INDEX_DB) is not bound, so the UI hides the search and the routes answer 404.
 */
export function activeToolFeatures(deps: Pick<Deps, "config" | "indexDb">): ToolFeature[] {
  const f = deps.config.tools.features;
  return deps.indexDb ? f : f.filter((x) => x !== "index");
}

/** True when Tools is on for this deployment and the P2 feature is listed in TOOLS_FEATURES (and usable here). */
export function toolFeatureOn(c: Context<AppEnv>, f: ToolFeature): boolean {
  const t = c.var.deps.config.tools;
  return t.enabled && activeToolFeatures(c.var.deps).includes(f);
}

/** Routes of a P2 feature answer a plain 404 while its flag is off, like Tools itself. */
export function requireToolFeature(c: Context<AppEnv>, f: ToolFeature): void {
  if (!toolFeatureOn(c, f)) throw notFound("Page");
}
