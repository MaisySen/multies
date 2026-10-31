import { describe, it, expect, beforeEach } from "vitest";

/** R79: the calm shell. Per person layout prefs and the navigation map behind the rail, sidebar and breadcrumbs. */
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
}
const store = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = store;

const prefs = await import("@/web/lib/layout-prefs");
const nav = await import("@/web/layouts/shell-nav");

describe("layout prefs", () => {
  beforeEach(() => { store.clear(); prefs.setLayoutUser("user_a"); });

  it("sanitizes junk back to the defaults", () => {
    expect(prefs.sanitize(null)).toEqual(prefs.DEFAULT_LAYOUT);
    const s = prefs.sanitize({ mailPane: "sideways", density: "huge", taskDetails: 3, favourites: [{ kind: "x" }], sidebarCollapsed: "yes" });
    expect(s.mailPane).toBe(prefs.DEFAULT_LAYOUT.mailPane);
    expect(s.density).toBe(prefs.DEFAULT_LAYOUT.density);
    expect(s.favourites).toEqual([]);
    expect(s.sidebarCollapsed).toBe(false);
  });

  it("keeps each person's layout apart", () => {
    prefs.setLayout({ mailPane: "bottom", density: "compact" });
    expect(prefs.readLayout().mailPane).toBe("bottom");
    prefs.setLayoutUser("user_b");
    expect(prefs.readLayout().mailPane).toBe(prefs.DEFAULT_LAYOUT.mailPane);
    prefs.setLayoutUser("user_a");
    expect(prefs.readLayout()).toMatchObject({ mailPane: "bottom", density: "compact" });
  });

  it("folds the sidebar per page kind: Mail has its own folder list", () => {
    const p = prefs.readLayout();
    expect(prefs.sidebarHiddenOn(p, "/app/tasks")).toBe(false);
    expect(prefs.sidebarHiddenOn(p, "/app/mail")).toBe(true);
    prefs.toggleSidebar("/app/tasks");
    expect(prefs.sidebarHiddenOn(prefs.readLayout(), "/app/tasks")).toBe(true);
    expect(prefs.sidebarHiddenOn(prefs.readLayout(), "/app/mail")).toBe(true);
    prefs.toggleSidebar("/app/mail");
    expect(prefs.sidebarHiddenOn(prefs.readLayout(), "/app/mail")).toBe(false);
  });

  it("toggles favourites and Reset layout keeps them while clearing pane sizes", () => {
    const fav = { kind: "project" as const, id: "prj_1", label: "Launch", to: "/app/tasks?project=prj_1" };
    prefs.toggleFavourite(fav);
    expect(prefs.isFavourite(prefs.readLayout(), "project", "prj_1")).toBe(true);
    prefs.setLayout({ mailPane: "off" });
    prefs.panelStorage.setItem("shell", "[30,70]");
    const gen = prefs.layoutGeneration();
    prefs.resetLayout();
    const after = prefs.readLayout();
    expect(after.mailPane).toBe(prefs.DEFAULT_LAYOUT.mailPane);
    expect(after.favourites).toHaveLength(1);
    expect(prefs.panelStorage.getItem("shell")).toBeNull();
    expect(prefs.layoutGeneration()).toBe(gen + 1);
    prefs.toggleFavourite(fav);
    expect(prefs.isFavourite(prefs.readLayout(), "project", "prj_1")).toBe(false);
  });
});

describe("shell navigation", () => {
  it("hides flagged pages and empty sections", () => {
    const off = nav.visibleSections({});
    const on = nav.visibleSections({ tools: true, files: true, scheduling: true, operator: true });
    expect(on.length).toBeGreaterThanOrEqual(off.length);
    for (const s of off) for (const p of s.pages) expect(p.flag).toBeUndefined();
  });

  it("finds the section and page by the longest match", () => {
    expect(nav.sectionFor("/app/mail").id).toBe("mail");
    expect(nav.sectionFor("/app/tasks/timeline").id).toBe("tasks");
    expect(nav.pageFor("/app/mail")?.page.to).toBe("/app/mail");
  });

  it("builds breadcrumbs with the project name", () => {
    const c = nav.breadcrumbs("/app/tasks", "?project=prj_1", { projectName: "Launch" });
    expect(c.map((x) => x.label)).toContain("Launch");
    expect(c[0].label).toBeTruthy();
  });

  it("offers Create items and sends File to Docs when tools are off", () => {
    const kinds = nav.createItems({}).map((x) => x.kind);
    expect(kinds).toEqual(["task", "doc", "mail", "event", "file"]);
    expect(nav.createItems({}).find((x) => x.kind === "file")!.to).toMatch(/docs/);
    expect(nav.createItems({ tools: true }).find((x) => x.kind === "file")!.to).toMatch(/tools/);
  });
});
