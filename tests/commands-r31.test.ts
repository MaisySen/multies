import { readFileSync } from "node:fs";
import { movedPath } from "@/shared/nav-menu"; // R121
import { describe, expect, it } from "vitest";
import { COMMANDS, SEQUENCE_MS, activeScopes, bindCommand, commandById, idleKeys, inSheet, isPlainKeys, readKeys, runCommand, registerCommandModule, type CommandContext } from "@/web/lib/commands";
import { getFocus, setFocus, setFocusList, stepFocus, clearFocus } from "@/web/lib/commands/focus";
import { taskPickerItems } from "@/web/lib/commands/task-pickers";
import { SHORTCUTS, sheetShortcuts } from "@/web/lib/shortcuts";
import type { Project, Task } from "@/web/pages/app/work/data";

const ctx = (): CommandContext & { log: string[] } => {
  const log: string[] = [];
  return { log, navigate: (to) => log.push(`nav:${to}`), openSheet: () => log.push("sheet"), openPalette: (p) => log.push(`palette:${p ?? ""}`), toggleTheme: () => log.push("theme") };
};
const press = (keys: string[], scopes: Parameters<typeof readKeys>[3]) => {
  let state = idleKeys();
  const results: ReturnType<typeof readKeys>["result"][] = [];
  keys.forEach((k, i) => { const r = readKeys(state, { key: k }, 1000 + i * 100, scopes); state = r.state; results.push(r.result); });
  return results[results.length - 1] ?? { kind: "none" as const };
};

describe("R31 one command registry", () => {
  it("ids are unique", () => expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length));

  it("every key (or sequence) is unique per scope", () => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS.filter((x) => x.keys?.length && x.handler !== "local")) {
      const k = `${c.scope}:${c.keys!.join("+")}`;
      expect(seen.get(k), `${c.id} clashes with ${seen.get(k)}`).toBeUndefined();
      seen.set(k, c.id);
    }
  });

  it("every command in the sheet has a handler: its own run, a page binding found in the source, or a field that handles it", () => {
    const sources = ["src/web/pages/app/work/crm-suggestions-td10.tsx", "src/web/pages/app/work/contacts.tsx", "src/web/pages/app/analyses-td10.tsx" /* TD10 */, "src/web/pages/app/webmail.tsx", "src/web/lib/commands/use-task-focus.ts", "src/web/components/shortcuts-sheet.tsx", "src/web/components/palette-host.tsx", "src/web/pages/app/work/tasks.tsx" /* R34 board lanes */, "src/web/pages/app/work/timeline-plan-r37.tsx" /* R37 date clashes */].map((f) => readFileSync(f, "utf8")).join("\n");
    for (const c of COMMANDS.filter(inSheet)) {
      if (c.handler === "run") expect(typeof c.run, c.id).toBe("function");
      else if (c.handler === "page") expect(sources, c.id).toContain(`"${c.id}"`);
      else expect(c.handler).toBe("local");
    }
  });

  it("every /app route has a go to command in the command menu", () => {
    const router = readFileSync("src/web/router.tsx", "utf8");
    const app = router.slice(router.indexOf('path: "/app"'), router.indexOf('path: "/f/:slug"'));
    const settingsAt = app.indexOf('path: "settings"');
    const paths = [...app.matchAll(/path: "([^"]+)"/g)].map((m) => ({ p: m[1], at: m.index! }))
      .filter(({ at }) => !app.slice(at, app.indexOf("\n", at)).includes("<Moved")) // R82F: a moved address redirects to its new page
      .filter(({ p }) => p !== "/app" && !p.includes(":") && p !== "admin" && !p.startsWith("admin/")) // operator pages stay out of the menu
      .map(({ p, at }) => (p === "settings" ? "/app/settings" : at > settingsAt ? `/app/settings/${p}` : `/app/${p}`));
    // R121: with P2 on, a go to command for a moved page opens its new home (Settings, Mail setup), so both count.
    const nav = new Set(COMMANDS.filter((c) => c.group === "Go to" && c.palette).flatMap((c) => [c.to, c.to ? movedPath(c.to) ?? c.to : c.to]));
    expect(paths.filter((p) => !nav.has(p))).toEqual([]);
  });

  it("has the go to sequences G I, G T, G D, G C, G M and G N", () => {
    const want: Record<string, string> = { I: "/app/mail", T: "/app/tasks", D: "/app/docs", C: "/app/chat", M: "/app/meetings", N: "/app/notifications" };
    for (const [k, to] of Object.entries(want)) {
      const r = press(["g", k.toLowerCase()], ["global"]);
      expect(r.kind === "run" && r.command.to, k).toBe(to);
    }
  });

  it("the sheet lists the task keys S, A, P, L, D and the mail keys E, R, A, F, #, S, U, H", () => {
    const keysOf = (group: string) => SHORTCUTS.filter((s) => s.group === group).map((s) => s.keys.join(""));
    expect(keysOf("Tasks")).toEqual(expect.arrayContaining(["S", "A", "P", "L", "D", "J", "K"]));
    expect(keysOf("Mail")).toEqual(expect.arrayContaining(["E", "R", "A", "F", "#", "S", "U", "H", "J", "K"]));
    expect(sheetShortcuts().length).toBe(SHORTCUTS.length);
  });

  it("no copy uses dashes or emoji", () => {
    for (const c of COMMANDS) expect(c.title).not.toMatch(/[\u2013\u2014]|\p{Extended_Pictographic}/u);
  });
});

describe("R31 key reader", () => {
  it("the most specific scope wins: S stars a message, sets a task's status, and is nothing elsewhere", () => {
    const m = press(["s"], activeScopes("/app/mail", { kind: "mail", id: "m1", list: [], listKind: null }));
    expect(m.kind === "run" && m.command.id).toBe("mail-star");
    const t = press(["s"], activeScopes("/app/tasks", { kind: "task", id: "t1", list: [], listKind: null }));
    expect(t.kind === "run" && t.command.id).toBe("task-status");
    expect(press(["s"], activeScopes("/app/docs", { kind: null, id: null, list: [], listKind: null })).kind).toBe("none");
  });

  it("G then S still goes to Settings with a task focused", () => {
    const r = press(["g", "s"], ["task", "tasks-list", "global"]);
    expect(r.kind === "run" && r.command.to).toBe("/app/settings");
  });

  it("a sequence times out after about a second", () => {
    const r1 = readKeys(idleKeys(), { key: "g" }, 0, ["global"]);
    const r2 = readKeys(r1.state, { key: "i" }, SEQUENCE_MS + 50, ["global"]);
    expect(r2.result.kind).toBe("none");
    expect(SEQUENCE_MS).toBeLessThanOrEqual(1200);
  });

  it("chords, named keys and field keys are not read as single keys", () => {
    expect(isPlainKeys(commandById("palette")!)).toBe(false);
    expect(isPlainKeys(commandById("chat-send")!)).toBe(false);
    expect(readKeys(idleKeys(), { key: "Enter" }, 0, ["global", "writing"]).result.kind).toBe("none");
    expect(readKeys(idleKeys(), { key: "e", altKey: true }, 0, ["mail-message", "mail", "global"]).result.kind).toBe("none");
  });
});

describe("R31 running commands", () => {
  it("runs its own run, or the newest page binding; unbound page commands pass", () => {
    const c = ctx();
    expect(runCommand(commandById("go-t")!, c)).toBe(true);
    expect(c.log).toEqual(["nav:/app/tasks"]);
    expect(runCommand(commandById("task-status")!, c)).toBe(true);
    expect(c.log).toContain("palette:task:status");
    const archive = commandById("mail-archive")!;
    expect(runCommand(archive, c)).toBe(false);
    const hits: string[] = [];
    const off1 = bindCommand("mail-archive", () => { hits.push("a"); });
    const off2 = bindCommand("mail-archive", () => { hits.push("b"); });
    expect(runCommand(archive, c)).toBe(true);
    off2();
    expect(runCommand(archive, c)).toBe(true);
    off1();
    expect(hits).toEqual(["b", "a"]);
    const off3 = bindCommand("mail-archive", () => false);
    expect(runCommand(archive, c)).toBe(false);
    off3();
  });

  it("another area adds its commands with a module", () => {
    const before = COMMANDS.length;
    registerCommandModule([{ id: "x-test", title: "Test", group: "General", scope: "global", handler: "run", run: () => undefined }]);
    registerCommandModule([{ id: "x-test", title: "Test", group: "General", scope: "global", handler: "run", run: () => undefined }]);
    expect(COMMANDS.length).toBe(before + 1);
    COMMANDS.splice(COMMANDS.findIndex((c) => c.id === "x-test"), 1);
  });
});

describe("R31 focus", () => {
  it("j/k walk the visible rows and stop at the ends", () => {
    clearFocus();
    setFocusList("task", ["a", "b", "c"]);
    expect(stepFocus(getFocus(), 1)).toBe("a");
    expect(stepFocus(getFocus(), -1)).toBe("c");
    setFocus("task", "b");
    expect(stepFocus(getFocus(), 1)).toBe("c");
    setFocus("task", "c");
    expect(stepFocus(getFocus(), 1)).toBe("c");
    setFocus("task", "a");
    expect(stepFocus(getFocus(), -1)).toBe("a");
    setFocus("task", null);
    expect(getFocus().kind).toBeNull();
    clearFocus();
    expect(stepFocus(getFocus(), 1)).toBeNull();
  });
});

describe("R31 task pickers", () => {
  const project = { id: "p1", statuses: [{ id: "s2", name: "In progress", category: "doing", color: "#f90", position: 2 }, { id: "s1", name: "To do", category: "todo", color: "#999", position: 1 }, { id: "s3", name: "Done", category: "done", color: "#0a0", position: 3 }] } as unknown as Project;
  const task = { id: "t1", projectId: "p1", statusId: "s1", assigneeId: null, priority: "none", labels: ["bug"], due: null } as unknown as Task;
  const base = { projects: [project], people: [{ id: "u1", type: "member" as const, name: "Ana", email: "ana@x.test" }], labels: ["bug", "ui"] };

  it("status lists the project's statuses in order, marks the current one, and patches statusId", () => {
    const items = taskPickerItems("status", task, base);
    expect(items.map((i) => i.label)).toEqual(["To do", "In progress", "Done"]);
    expect(items[0].current).toBe(true);
    expect(items[2].patch).toEqual({ statusId: "s3" });
    expect(items[2].view).toMatchObject({ statusName: "Done", status: "done" });
  });

  it("assignee offers Nobody first and patches assignee", () => {
    const items = taskPickerItems("assignee", task, base);
    expect(items[0]).toMatchObject({ label: "Nobody", current: true, patch: { assignee: null } });
    expect(items[1]).toMatchObject({ label: "Ana", patch: { assignee: "u1" } });
  });

  it("priority covers every level", () => {
    expect(taskPickerItems("priority", task, base).map((i) => i.id)).toEqual(["urgent", "high", "medium", "low", "none"]);
  });

  it("label toggles existing labels and offers a new one from the search", () => {
    const items = taskPickerItems("label", task, { ...base, search: "design" });
    expect(items[0]).toMatchObject({ id: "label-new", label: "design", patch: { labels: ["bug", "design"] } });
    expect(items.find((i) => i.label === "bug")).toMatchObject({ current: true, patch: { labels: [] } });
    expect(taskPickerItems("label", task, { ...base, search: "BUG" }).some((i) => i.id === "label-new")).toBe(false);
  });

  it("due offers today, tomorrow, next week, two weeks and none, as local dates", () => {
    const now = new Date(2026, 9, 26, 15, 0); // Monday 26 October 2026
    const items = taskPickerItems("due", task, { ...base, now });
    expect(items.map((i) => i.patch.due)).toEqual(["2026-10-26", "2026-10-27", "2026-11-02", "2026-11-09", null]);
  });
});
