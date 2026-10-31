/**
 * P1 layout: daily tools out of Settings. Social has its own place in the rail (Planner, Posts, New post, Accounts),
 * Agents and Settings sit at the bottom, Settings has one sidebar, and the old addresses still work.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as nav from "@/web/layouts/shell-nav";
import { ownsSidebar, sidebarHiddenOn } from "@/web/lib/layout-prefs";
import { monthGrid, postsByDay } from "@/web/pages/app/social";
import { cannotTake, postMatches } from "@/web/pages/app/apps-social";
import { SETTINGS_GROUPS } from "@/web/pages/app/settings";
import { CONNECTION_TABS, connectionsTabFor } from "@/web/pages/app/apps-settings";
import { PALETTE_PAGES } from "@/web/lib/palette-registry";
import type { ConnectedAccountView, SocialPostView } from "@/shared/integrations";

const acc = (app: string): ConnectedAccountView => ({ id: `a-${app}`, app, appName: app === "instagram" ? "Instagram" : app === "linkedin" ? "LinkedIn" : "Facebook", label: null, status: "active", createdAt: new Date().toISOString() } as unknown as ConnectedAccountView);
const post = (id: string, status: SocialPostView["status"], runAt: string): SocialPostView => ({ id, text: id, imageUrl: null, status, runAt, createdAt: runAt, createdBy: null, targets: [] });

describe("P1 rail", () => {
  it("has Social after Docs and Agents then Settings last", () => {
    expect(nav.SECTIONS.map((s) => s.id)).toEqual(["home", "mail", "tasks", "docs", "social", "tools", "chat", "dashboards", "agents", "workspace"]);
    expect(nav.SECTIONS.find((s) => s.id === "workspace")!.label).toBe("Settings");
    expect(nav.SECTIONS.find((s) => s.id === "social")!.pages.map((p) => p.label)).toEqual(["Planner", "Posts", "Library", "Accounts"]); // R117: Library (behind the Social P2 flag)
  });
  it("Agents is no longer a Settings page", () => {
    const ws = nav.SECTIONS.find((s) => s.id === "workspace")!;
    expect(ws.pages.some((p) => p.to === "/app/agents")).toBe(false);
    expect(nav.sectionFor("/app/agents").id).toBe("agents");
    expect(nav.sectionFor("/app/agents/abc").id).toBe("agents");
  });
  it("Social pages, the composer and their crumbs and titles", () => {
    expect(nav.sectionFor("/app/social").id).toBe("social");
    expect(nav.sectionFor("/app/social/new").id).toBe("social");
    expect(nav.breadcrumbs("/app/social/new", "").map((c) => c.label)).toEqual(["Social", "New post"]);
    expect(nav.breadcrumbs("/app/social", "").map((c) => c.label)).toEqual(["Social", "Planner"]);
    expect(nav.pageTitle("/app/social/accounts")).toBe("Accounts · Multies");
    expect(nav.pageTitle("/app/settings/branding")).toBe("Branding · Settings · Multies");
  });
  it("Create, Social post opens the composer in Social", () => {
    expect(nav.createItems({ social: true }).find((c) => c.kind === "post")?.to).toBe("/app/social/new");
    expect(nav.createItems({ social: false }).some((c) => c.kind === "post")).toBe(false);
  });
  it("the command menu reaches every Social page", () => {
    for (const to of ["/app/social", "/app/social/posts", "/app/social/new", "/app/social/accounts"]) expect(PALETTE_PAGES.some((p) => p.to === to)).toBe(true);
    expect(PALETTE_PAGES.some((p) => p.to === "/app/settings/apps/social")).toBe(false);
  });
});

describe("P1 Settings", () => {
  it("has one sidebar: the shell's folds away on every settings page and cannot be toggled back", () => {
    const prefs = { sidebarCollapsed: false, sidebarOnMail: true } as Parameters<typeof sidebarHiddenOn>[0];
    expect(ownsSidebar("/app/settings")).toBe(true);
    expect(ownsSidebar("/app/settings/apps/mail")).toBe(true);
    expect(sidebarHiddenOn(prefs, "/app/settings/team")).toBe(true);
    expect(sidebarHiddenOn(prefs, "/app/activity")).toBe(false);
    expect(sidebarHiddenOn(prefs, "/app/social")).toBe(false);
  });
  it("lists Activity and Operator in its own list", () => {
    const admin = SETTINGS_GROUPS.find((g) => g.label === "Admin")!;
    expect(admin.items.map((i) => i.to)).toEqual(["/app/activity", "/app/admin"]);
  });
  it("Connections has no Social posts tab", () => {
    expect(CONNECTION_TABS.map((t) => t.label)).toEqual(["Apps", "Mail accounts", "Webhooks"]);
    expect(connectionsTabFor("/app/settings/apps/social")).toBe("apps");
  });
  it("old addresses redirect, and sign ins come back to Social", () => {
    const router = readFileSync("src/web/router.tsx", "utf8");
    expect(router).toMatch(/path: "apps\/social", element: <MovedSocial \/>/);
    expect(router).toMatch(/"\/app\/social\/accounts" : "\/app\/social\/new"/);
    expect(readFileSync("src/server/routes/direct-social.ts", "utf8")).toContain("/app/social/accounts?");
  });
});

describe("P1 composer greys out what a network cannot take", () => {
  it("needs an image, too long, or fine", () => {
    expect(cannotTake(acc("instagram"), { image: false, length: 10, broken: false })).toMatch(/needs an image/);
    expect(cannotTake(acc("instagram"), { image: true, length: 10, broken: false })).toBeNull();
    expect(cannotTake(acc("linkedin"), { image: false, length: 3001, broken: false })).toMatch(/Too long for LinkedIn/);
    expect(cannotTake(acc("facebook"), { image: false, length: 10, broken: false })).toBeNull();
    // A broken sign in has its own line from the account check.
    expect(cannotTake(acc("instagram"), { image: false, length: 10, broken: true })).toBeNull();
  });
  it("no dashes in the reasons", () => {
    expect(cannotTake(acc("linkedin"), { image: false, length: 9999, broken: false })).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("P1 posts and planner", () => {
  it("filters Scheduled, Sent and Failed", () => {
    const p = [post("a", "scheduled", "2026-11-02T01:00:00Z"), post("b", "done", "2026-11-01T01:00:00Z"), post("c", "failed", "2026-11-01T02:00:00Z"), post("d", "partial", "2026-11-01T03:00:00Z")];
    expect(p.filter((x) => postMatches(x, "scheduled")).map((x) => x.id)).toEqual(["a"]);
    expect(p.filter((x) => postMatches(x, "sent")).map((x) => x.id)).toEqual(["b", "d"]);
    expect(p.filter((x) => postMatches(x, "failed")).map((x) => x.id)).toEqual(["c", "d"]);
    expect(p.filter((x) => postMatches(x, "all"))).toHaveLength(4);
  });
  it("a month is whole weeks starting Monday", () => {
    const g = monthGrid(2026, 10); // November 2026 starts on a Sunday
    expect(g.length % 7).toBe(0);
    expect(g[0]!.getDay()).toBe(1);
    expect(g.some((d) => d.getMonth() === 10 && d.getDate() === 30)).toBe(true);
  });
  it("groups posts by day in time order and leaves canceled ones out", () => {
    const m = postsByDay([post("late", "done", new Date(2026, 10, 3, 15).toISOString()), post("early", "scheduled", new Date(2026, 10, 3, 9).toISOString()), post("x", "canceled", new Date(2026, 10, 3, 10).toISOString())]);
    expect([...m.values()][0]!.map((p) => p.id)).toEqual(["early", "late"]);
  });
});
