/**
 * MPT-10 (NAV1 slice 1): every app page has a home in the menu. The test reads every /app route from
 * src/web/router.tsx. It skips detail routes (a path with an id, like /app/tasks/:ref) and redirects (Moved).
 * A page has a home when it is one of these:
 * - a rail entry or section in SECTIONS_P1 or SECTIONS_P2 (src/shared/nav-menu.ts);
 * - a Settings pane (SETTINGS_GROUPS or SETTINGS_GROUPS_P2);
 * - a Tools hub tile (buildEntries in src/web/components/tools/tool-directory.ts);
 * - a declared parent in NAV_PARENTS (src/shared/nav-parents.ts), whose file links to the page.
 * A page with no home yet must be in NAV_NO_HOME_YET, with a reason and the NAV1 slice that gives it a home.
 * tests/nav-p2-r121.test.ts and tests/known-routes.test.ts check the other direction (every menu entry is a page).
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECTIONS_P1, SECTIONS_P2 } from "@/shared/nav-menu";
import { NAV_NO_HOME_YET, NAV_PARENTS } from "@/shared/nav-parents";
import { SETTINGS_GROUPS, SETTINGS_GROUPS_P2 } from "@/web/pages/app/settings";
import { buildEntries } from "@/web/components/tools/tool-directory";

type Route = { path: string; element: string };

/** Every route under /app in the router, with the name of its element (page(<X />) reads as X). */
function appRoutes(src: string): { routes: Route[]; lines: number } {
  const appStart = src.indexOf('path: "/app",');
  const setStart = src.indexOf('path: "settings",', appStart);
  const setEnd = src.indexOf("],", setStart);
  const re = /\{ (?:path: "([^"]+)"|index: true), element: (?:page\()?<([A-Za-z0-9]+)/g;
  const routes: Route[] = [];
  for (const m of src.slice(appStart, setStart).matchAll(re)) routes.push({ path: m[1] === undefined ? "/app" : `/app/${m[1]}`, element: m[2] });
  for (const m of src.slice(setStart, setEnd).matchAll(re)) routes.push({ path: m[1] === undefined ? "/app/settings" : `/app/settings/${m[1]}`, element: m[2] });
  const block = src.slice(appStart, setEnd);
  const lines = (block.match(/\{ (?:path: "|index: true)/g) ?? []).length; // every route line, to prove the reader skips none
  return { routes, lines };
}
const REDIRECTS = new Set(["Moved", "MovedSocial"]);
const pagesOf = (routes: Route[]) => routes.filter((r) => !r.path.includes(":") && !REDIRECTS.has(r.element)).map((r) => r.path);

const strip = (to: string) => to.replace(/[?#].*$/, "");
/** Every feature a Tools tile can sit behind, so every tile counts as a home. */
const ALL_TOOL_FEATURES = ["editor", "tools_c", "tools_c2", "esign", "share", "vault_r128", "links", "ask_r110", "ask", "translate", "extract", "expenses", "contracts", "workflows", "templates", "merge_mail", "rules"];
function menuHomes(): Set<string> {
  return new Set([
    ...[...SECTIONS_P1, ...SECTIONS_P2].flatMap((s) => [s.to, ...s.pages.map((p) => p.to)]),
    ...[...SETTINGS_GROUPS, ...SETTINGS_GROUPS_P2].flatMap((g) => g.items.map((p) => p.to)),
    ...buildEntries([], ALL_TOOL_FEATURES).flatMap((e) => (e.to ? [e.to] : [])),
  ].map(strip));
}

/** Pages with no menu entry, Settings pane, Tools tile, declared parent or allowlist entry. */
function missingHomes(pages: string[], homes: Set<string>, parents: Record<string, unknown>, noHomeYet: Record<string, unknown>): string[] {
  return pages.filter((p) => !homes.has(p) && !(p in parents) && !(p in noHomeYet));
}
const missingMessage = (missing: string[]) => missing.length === 0 ? "" :
  `These app pages have no home in the menu: ${missing.join(", ")}. Give each one a rail entry in src/shared/nav-menu.ts, a Settings pane, a Tools tile, or a declared parent in src/shared/nav-parents.ts (NAV_PARENTS).`;

const router = readFileSync("src/web/router.tsx", "utf8");
const { routes, lines } = appRoutes(router);
const pages = pagesOf(routes);
const homes = menuHomes();

describe("every app page has a menu home (MPT-10, NAV1 slice 1)", () => {
  it("reads every /app route in the router, and skips only detail routes and redirects", () => {
    expect(routes.length).toBe(lines);
    expect(pages.length).toBeGreaterThan(80);
    for (const p of ["/app", "/app/tasks", "/app/settings", "/app/settings/team"]) expect(pages).toContain(p);
    for (const p of ["/app/tasks/:ref", "/app/integrations", "/app/settings/connections"]) expect(pages).not.toContain(p);
  });

  it("gives every page a home: a rail entry, a Settings pane, a Tools tile, a declared parent, or the allowlist", () => {
    expect(missingMessage(missingHomes(pages, homes, NAV_PARENTS, NAV_NO_HOME_YET))).toBe("");
  });

  it("declares each parent for a real page, and the parent's file links to that page", () => {
    for (const [route, d] of Object.entries(NAV_PARENTS)) {
      expect(pages, route).toContain(route);
      expect(homes.has(route), `${route} has a menu home now: remove it from NAV_PARENTS`).toBe(false);
      expect(pages, `${route}: parent ${d.parent} is not an app page`).toContain(d.parent);
      expect(existsSync(d.file), `${route}: ${d.file} does not exist`).toBe(true);
      const linked = new RegExp(`${route.replace(/[/]/g, "\\/")}(?=["'\`?#])`).test(readFileSync(d.file, "utf8"));
      expect(linked, `${route}: ${d.file} does not link to it`).toBe(true);
      expect(d.reason.trim().length, route).toBeGreaterThan(0);
    }
  });

  it("lists each page without a home with a reason and the NAV1 slice that will give it one", () => {
    for (const [route, d] of Object.entries(NAV_NO_HOME_YET)) {
      expect(pages, route).toContain(route);
      expect(homes.has(route) || route in NAV_PARENTS, `${route} has a home now: remove it from NAV_NO_HOME_YET`).toBe(false);
      expect(d.reason.trim().length, route).toBeGreaterThan(0);
      expect(d.slice, route).toMatch(/^NAV1 /);
    }
  });

  it("fails for a new route without a home, and names the route and the fix", () => {
    const missing = missingHomes([...pages, "/app/new-page"], homes, NAV_PARENTS, NAV_NO_HOME_YET);
    expect(missing).toEqual(["/app/new-page"]);
    expect(missingMessage(missing)).toContain("/app/new-page");
    expect(missingMessage(missing)).toContain("src/shared/nav-parents.ts");
  });

  it("fails when a page leaves the allowlist without getting a home", () => {
    for (const route of Object.keys(NAV_NO_HOME_YET)) {
      const rest = Object.fromEntries(Object.entries(NAV_NO_HOME_YET).filter(([r]) => r !== route));
      expect(missingHomes(pages, homes, NAV_PARENTS, rest)).toEqual([route]);
    }
  });
});
