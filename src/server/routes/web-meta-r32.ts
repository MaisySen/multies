/**
 * R32: small public files the web app and agents read.
 * - /version.json: { release, critical } so open tabs can offer a reload when a new release ships.
 *   critical is true only when CRITICAL_RELEASE equals the running release. Never cached.
 * - /llms.txt and /llms-full.txt: the public developer docs for agents (llmstxt.org format), built
 *   from docs/ at build time by scripts/build-llms.ts, so they never drift. Cached for an hour.
 */
import type { Context } from "hono";
import type { AppEnv } from "../context";
import { LLMS_FULL_TXT, LLMS_TXT } from "../generated/llms.generated";

export const WEB_META_PATHS = new Set(["/version.json", "/llms.txt", "/llms-full.txt"]);

export function versionPayload(release: string, criticalRelease: string | undefined) {
  return { release, critical: !!criticalRelease && criticalRelease === release };
}

export function versionJson(c: Context<AppEnv>) {
  const cfg = c.var.deps.config;
  c.header("cache-control", "no-store, max-age=0");
  return c.json(versionPayload(cfg.release, cfg.criticalRelease));
}

const text = (c: Context<AppEnv>, body: string) => {
  c.header("content-type", "text/plain; charset=utf-8");
  c.header("cache-control", "public, max-age=3600");
  return c.body(body);
};
export const llmsTxt = (c: Context<AppEnv>) => text(c, LLMS_TXT);
export const llmsFullTxt = (c: Context<AppEnv>) => text(c, LLMS_FULL_TXT);
