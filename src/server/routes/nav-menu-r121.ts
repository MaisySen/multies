/**
 * R121 (NAV_P2_R121): GET /api/nav/menu, the one menu model for the mobile app (and anything else that draws the menu).
 * The same typed sections the web rail and the phone More sheet use (src/shared/nav-menu.ts), filtered by this person's
 * switches and role. No database read: it answers from config and the session only. Pages tied to a switch the server
 * cannot know without a read (Sites shows once the workspace has one) carry `whenUsed` and the app asks their own route.
 */
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context";
import { requireAuth } from "../middleware";
import { activeToolFeatures } from "../services/tools/features";
import { COUNT_KEYS, FOURTH_TABS, MAIL_SETUP, MENU_VERSION, SECTIONS_P1, SECTIONS_P2, visibleIn, type NavFlagSet } from "@/shared/nav-menu";

/** The switches this person has, as the web shell computes them (app.tsx navFlags), minus the per workspace Sites read. */
export function serverNavFlags(deps: Pick<Deps, "config">, who: { role: "owner" | "admin" | "member"; platformRole?: string }): NavFlagSet & { social: boolean } {
  const cfg = deps.config;
  const tools = !!cfg.tools?.enabled;
  const features = tools ? activeToolFeatures(deps as Deps) : [];
  return {
    tools,
    files: tools && (features.includes("folders") || !!cfg.filesPlus),
    scheduling: !!cfg.schedulingEnabled,
    operator: who.platformRole === "admin",
    flows: cfg.flows !== false,
    socialP2: cfg.socialP2 !== false,
    socialP2b: cfg.socialP2 !== false && cfg.socialP2b !== false,
    helpCenter: !!cfg.helpCenter,
    docsPlus: !!cfg.docsPlus,
    sites: !!cfg.sites, // shown only once the workspace has a site: see whenUsed
    social: who.role === "owner" || who.role === "admin" || cfg.socialP2 !== false,
  };
}

export function menuFor(deps: Pick<Deps, "config">, who: { role: "owner" | "admin" | "member"; platformRole?: string }) {
  const p2 = !!deps.config.navP2R121;
  const flags = serverNavFlags(deps, who);
  const sections = visibleIn(p2 ? SECTIONS_P2 : SECTIONS_P1, flags).map((s) => ({
    id: s.id, label: s.label, icon: s.icon, to: s.to,
    pages: s.pages.map((p) => ({ to: p.to, label: p.label, icon: p.icon, ...(p.end ? { end: true } : {}),
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
