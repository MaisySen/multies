/**
 * QUAL1 (audit rows 29, 48, 58): app addresses that read a word as an id ("Agent not found" on /app/agents/automations,
 * /app/dashboards/reports, a contact called "companies"), asked the API for /api/sites/pages/blog, or showed the not
 * found page without an id (/app/files/edit, /app/go, the merge tabs, /app/automations/flows) now open the list they
 * belong to. /app/tools/ai opens Tools while its features are off, and Settings, Channels with chat channels off shows
 * the not found page instead of General.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { matchRoutes, type RouteObject } from "react-router";
import { APP_MOVES, movedTarget } from "@/web/lib/route-moves-qual1";

const router = readFileSync("src/web/router.tsx", "utf8");
const start = router.indexOf('path: "/app",');
const settingsAt = router.indexOf('path: "settings",', start);
const end = router.indexOf("// Public pages with no site header", start);
const pathsIn = (s: string) => [...s.matchAll(/\{ (?:index: true|path: "([^"]+)")/g)].map((m) => m[1]).filter((p): p is string => !!p);
const appPages = pathsIn(router.slice(start + 'path: "/app",'.length, settingsAt));
const settingsPages = pathsIn(router.slice(settingsAt + 'path: "settings",'.length, end));

/** The app's routes as the router has them (pages by path), with the moves added the way router.tsx adds them. */
const routes: RouteObject[] = [
  {
    path: "/app", id: "app", children: [
      ...appPages.map((p) => ({ path: p, id: `page:${p}` })),
      { path: "settings", id: "page:settings", children: [{ index: true, id: "settings:index" }, ...settingsPages.map((p) => ({ path: p, id: `settings:${p}` }))] },
      ...APP_MOVES.map((m) => ({ path: m.path, id: `move:${m.path}` })),
    ],
  },
  { path: "*", id: "not-found" },
];
const leaf = (pathname: string) => matchRoutes(routes, pathname)?.at(-1)?.route.id ?? "none";

describe("addresses that read a word as an id now open their list (QUAL1)", () => {
  const audited = [
    "/app/agents/automations", "/app/dashboards/reports", "/app/contacts/companies", "/app/contacts/portals", "/app/contacts/assets",
    "/app/docs/sites/blog", "/app/tools/merge/journeys", "/app/tools/merge/lists", "/app/tools/merge/newsletters",
    "/app/automations/flows", "/app/files/edit", "/app/go",
  ];

  it("the router reads its pages (sanity)", () => {
    expect(appPages).toContain("agents/:id");
    expect(appPages).toContain("contacts/:id");
    expect(settingsPages).toContain("channels");
  });

  it("each audited address lands on its move, not on an :id page or the not found page", () => {
    for (const a of audited) expect(leaf(a), a).toBe(`move:${a.replace(/^\/app\//, "")}`);
    // The pages with an id still open as before.
    expect(leaf("/app/agents/agt_1")).toBe("page:agents/:id");
    expect(leaf("/app/contacts/ctc_1")).toBe("page:contacts/:id");
    expect(leaf("/app/docs/sites/pg_1")).toBe("page:docs/sites/:pageId");
    expect(leaf("/app/docs/sites/blog/post_1")).toBe("page:docs/sites/blog/:postId");
    expect(leaf("/app/files/edit/fil_1")).toBe("page:files/edit/:id");
    expect(leaf("/app/go/handbook")).toBe("page:go/:name");
  });

  it("every move opens a real list page (no :id page, no other move, never not found)", () => {
    for (const m of APP_MOVES) {
      const target = new URL(m.to, "https://x").pathname;
      const id = leaf(target);
      expect(id, `${m.path} -> ${m.to}`).toMatch(/^page:/);
      expect(id.slice("page:".length), `${m.path} -> ${m.to}`).not.toContain(":");
    }
  });

  it("router.tsx adds every move and keeps the address's query and hash", () => {
    expect(router).toContain("...APP_MOVES.map((m) => ({ path: m.path, element: <Moved to={m.to} /> }))");
    expect(router).toContain("movedTarget(to, loc.search, loc.hash)");
    expect(movedTarget("/app/reports", "?range=7d", "#top")).toBe("/app/reports?range=7d#top");
    expect(movedTarget("/app/contacts?tab=companies", "?q=acme", "")).toBe("/app/contacts?tab=companies&q=acme");
    expect(movedTarget("/app/files", "", "")).toBe("/app/files");
  });

  it("/app/tools/ai opens Tools while its features are off (links pass ?feature=ask and ?feature=translate)", () => {
    const line = router.split("\n").find((l) => l.includes('path: "tools/ai"'))!;
    expect(line).toContain('offTo="/app/tools"');
    const gate = readFileSync("src/web/components/tools/feature-gate.tsx", "utf8");
    expect(gate).toContain("if (!on && offTo) return <Navigate to={offTo} replace />;");
  });

  it("an unknown or switched off Settings page shows not found, never General", () => {
    const channels = readFileSync("src/web/pages/app/channels-settings.tsx", "utf8");
    expect(channels).not.toContain('<Navigate to="/app/settings"');
    expect(channels).toContain("<NotFound embedded />");
    // An unknown Settings page already showed not found before QUAL1 (only Channels sent people to General): this
    // guards that the real router keeps it so, with no catch-all under settings and the app wide not found page last.
    const settingsBlock = router.slice(settingsAt, end);
    expect(settingsBlock).not.toMatch(/path: "\*"/);
    expect(router).toMatch(/\{ path: "\*", element: <NotFound \/> \}/);
    expect(leaf("/app/settings/no-such-page")).toBe("not-found");
  });
});
