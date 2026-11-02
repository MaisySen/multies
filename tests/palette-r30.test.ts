import { readFileSync } from "node:fs";
import { movedPath } from "@/shared/nav-menu"; // R121
import { describe, expect, it } from "vitest";
import { PALETTE_ACTIONS, PALETTE_PAGES, paletteScore, withinOneEdit } from "@/web/lib/palette-registry";

const score = (label: string, q: string, kw?: string[]) => paletteScore(`${label}|p-x`, q, kw);

describe("R30 command menu coverage", () => {
  it("every app page in the router is reachable from the command menu", () => {
    const router = readFileSync("src/web/router.tsx", "utf8");
    const app = router.slice(router.indexOf('path: "/app"'), router.indexOf('path: "/f/:slug"'));
    const settingsAt = app.indexOf('path: "settings"');
    // R82F (MB-279): an old address that only redirects (<Moved />) is not a page of its own.
    const paths = [...app.matchAll(/path: "([^"]+)"(.*)/g)].filter((m) => !m[2].includes("<Moved") && !m[2].includes("<MovedSocial")).map((m) => ({ p: m[1], at: m.index! }))
      .filter(({ p }) => p !== "/app" && !p.includes(":") && p !== "admin" && !p.startsWith("admin/")) // operator pages stay out of the menu
      .map(({ p, at }) => (p === "settings" ? "/app/settings" : at > settingsAt ? `/app/settings/${p}` : `/app/${p}`));
    // R121: with P2 on, the command menu opens a moved page at its new home (Settings, Mail setup), so both count.
    const covered = new Set(PALETTE_PAGES.flatMap((x) => [x.to, movedPath(x.to) ?? x.to]));
    const missing = paths.filter((p) => !covered.has(p));
    expect(missing).toEqual([]);
    expect(paths.length).toBeGreaterThan(30);
  });

  it("ids and labels are unique", () => {
    const all = [...PALETTE_PAGES, ...PALETTE_ACTIONS];
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length);
    expect(new Set(PALETTE_PAGES.map((x) => x.label)).size).toBe(PALETTE_PAGES.length);
  });

  it("has the create, theme and shortcuts actions", () => {
    const ids = PALETTE_ACTIONS.map((a) => a.id);
    for (const id of ["compose", "new-task", "new-doc", "new-chat", "shortcuts", "theme"]) expect(ids).toContain(id);
    expect(PALETTE_ACTIONS.find((a) => a.id === "new-task")!.to).toBe("/app/tasks?new=1");
    expect(PALETTE_ACTIONS.find((a) => a.id === "new-doc")!.to).toBe("/app/docs?new=1");
  });

  it("no copy uses dashes or emoji", () => {
    for (const x of [...PALETTE_PAGES, ...PALETTE_ACTIONS]) expect(x.label).not.toMatch(/[\u2013\u2014]|\p{Extended_Pictographic}/u);
  });
});

describe("R30 fuzzy matching", () => {
  it("empty search keeps everything", () => expect(score("Tasks", "")).toBe(1));
  it("ranks prefix over word start over substring", () => {
    expect(score("Shared inbox", "shared")).toBe(0.99); // F13: a prefix ranks just under an exact name
    expect(score("Shared inbox", "inb")).toBe(0.95);
    expect(score("Deliverability", "verab")).toBe(0.9);
  });
  it("matches keywords", () => {
    expect(score("Contacts", "crm", ["crm", "people"])).toBe(0.85);
    expect(score("Tasks", "anba", ["kanban"])).toBe(0.8);
  });
  it("matches initials", () => expect(score("New task", "nt")).toBe(0.75));
  it("matches words in any order", () => expect(score("Write an email", "email write")).toBe(0.7));
  it("forgives one typo in a longer word", () => {
    expect(score("Settings", "setings")).toBe(0.5);
    expect(score("Docs", "dosc")).toBe(0.5);
    expect(score("Mail", "xyzw")).toBe(0);
    expect(score("Automations", "atuomations")).toBe(0.5);
  });
  it("falls back to letters in order, tightly", () => {
    expect(score("Dashboards", "dshb")).toBeGreaterThan(0);
    expect(score("Dashboards", "dsrd")).toBe(0); // too spread out
    expect(score("Billing", "zq")).toBe(0);
  });
  it("never matches the id part of the value", () => expect(paletteScore("Tasks|p-tasks", "p-t")).toBe(0));
  it("one edit apart", () => {
    expect(withinOneEdit("abc", "abc")).toBe(true);
    expect(withinOneEdit("abc", "abd")).toBe(true);
    expect(withinOneEdit("abc", "acb")).toBe(true);
    expect(withinOneEdit("abc", "ab")).toBe(true);
    expect(withinOneEdit("abc", "abcd")).toBe(true);
    expect(withinOneEdit("abc", "xbz")).toBe(false);
    expect(withinOneEdit("abc", "a")).toBe(false);
  });
  it("finds the new pages by what people type", () => {
    const find = (q: string) => PALETTE_PAGES.concat().map((p) => ({ p, s: paletteScore(`${p.label}|${p.id}`, q, p.keywords) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0]?.p.to;
    expect(find("tasks")).toBe("/app/tasks");
    expect(find("kanban")).toBe("/app/tasks");
    expect(find("chat")).toBe("/app/chat");
    expect(find("pipeline")).toBe("/app/deals");
    expect(find("wiki")).toBe("/app/docs");
  });
});
