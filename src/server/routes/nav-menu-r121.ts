/**
 * R121 (NAV_P2_R121): GET /api/nav/menu, the one menu model for the mobile app (and anything else that draws the menu).
 * The same typed sections the web rail and the phone More sheet use (src/shared/nav-menu.ts), filtered by this person's
 * switches and role. No database read: it answers from config and the session only. Pages tied to a switch the server
 * cannot know without a read (Sites shows once the workspace has one) carry `whenUsed` and the app asks their own route.
 */
import { isOperatorRole } from "@/shared/operator-permissions";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context";
import { requireAuth } from "../middleware";
import { activeToolFeatures } from "../services/tools/features";
import { COUNT_KEYS, FOURTH_TABS, MAIL_SETUP, MENU_VERSION, SECTIONS_P1, SECTIONS_P2, visibleIn, type NavFlagSet } from "@/shared/nav-menu";
import { envDefault, featureOn, type FlagDeps } from "../services/console/flags"; // OPS1 feature flags
import type { FlagKey } from "@/shared/feature-flags";

type NavDeps = Pick<Deps, "config"> & Partial<Pick<Deps, "db" | "now">>;
type NavWho = { role: "owner" | "admin" | "member"; platformRole?: string; orgId?: string };

/**
 * OPS1 feature flags: a flag's value for the person's workspace (the operator overrides the /api/* middleware loaded).
 * Called with a bare config (no database handle), the env default as before.
 */
const navFlag = (deps: NavDeps, key: FlagKey, orgId?: string) => (deps.db && deps.now ? featureOn(deps as FlagDeps, key, orgId) : envDefault(deps.config, key));

/** The switches this person has, as the web shell computes them (app.tsx navFlags), minus the per workspace Sites read. */
export function serverNavFlags(deps: NavDeps, who: NavWho): NavFlagSet & { social: boolean } {
  const cfg = deps.config;
  const on = (key: FlagKey) => navFlag(deps, key, who.orgId);
  const tools = !!cfg.tools?.enabled;
  const features = tools ? activeToolFeatures(deps as Deps) : [];
  return {
    tools,
    files: tools && (features.includes("folders") || on("filesPlus")),
    scheduling: on("schedulingEnabled"),
    operator: isOperatorRole(who.platformRole), // OPS1: every operator role
    flows: on("flows"),
    socialP2: on("socialP2"),
    socialP2b: on("socialP2") && on("socialP2b"),
    helpCenter: on("helpCenter"),
    docsPlus: on("docsPlus"),
    sites: on("sites"), // shown only once the workspace has a site: see whenUsed
    social: who.role === "owner" || who.role === "admin" || on("socialP2"),
  };
}

/**
 * OPS1: the phone app opens only /app pages (its menu parser drops anything else, and its one time web sign in link
 * accepts only /app), so the operator console goes out as /app/admin, which the web app sends on to /console. That
 * works on every app version already installed, with no app update.
 */
const PHONE_PATHS: Record<string, string> = { "/console": "/app/admin" };
const phonePath = (to: string) => PHONE_PATHS[to] ?? to;

export function menuFor(deps: NavDeps, who: NavWho) {
  const p2 = navFlag(deps, "navP2R121");
  const flags = serverNavFlags(deps, who);
  const sections = visibleIn(p2 ? SECTIONS_P2 : SECTIONS_P1, flags).map((s) => ({
    id: s.id, label: s.label, icon: s.icon, to: phonePath(s.to),
    pages: s.pages.map((p) => ({ to: phonePath(p.to), label: p.label, icon: p.icon, ...(p.end ? { end: true } : {}),
      ...(p.flag === "sites" ? { whenUsed: "/api/sites/in-use" } : {}), ...(COUNT_KEYS[p.to] ? { count: COUNT_KEYS[p.to] } : {}) })),
  }));
  return {
    version: MENU_VERSION,
    navP2: p2,
    sections,
    bottom: ["agents", "workspace"],
    mailSetup: p2 ? MAIL_SETUP.map(({ to, label }) => ({ to, label })) : [],
    create: flags.social ? [{ label: "Social post", to: "/app/social/new" }] : [],
    phoneTabs: { order: ["home", "mail", "chat", "fourth", "more"], fourth: FOURTH_TABS.map(({ id, label, to }) => ({ id, label, to })), fourthDefault: "tasks" },
    counts: { url: "/api/counts" },
  };
}

export function navMenuRoutes() {
  return new Hono<AppEnv>().use("*", requireAuth).get("/menu", (c) => {
    c.header("Cache-Control", "private, max-age=300");
    c.header("Vary", "Authorization, Cookie");
    return c.json(menuFor(c.var.deps, c.var.auth));
  });
}
