import { describe, it, expect, afterEach } from "vitest";
import { COMMANDS, activeScopes, readKeys, idleKeys } from "@/web/lib/commands";
import type { Focus } from "@/web/lib/commands/focus";
import { crmCommands } from "@/web/lib/commands/modules/crm";
import { RESERVED_CHORDS, RESERVED_SINGLE, inKeyWidget, isSingleKey, setCrmScopeOn, setSingleKeysOff, singleKeysOff } from "@/web/lib/shortcut-pref-td10";
import { groupForPath, sheetShortcuts } from "@/web/lib/shortcuts";

const noFocus: Focus = { kind: null, id: null, list: [], listKind: null };
const norm = (keys: string[]) => keys.map((k) => (k === "Ctrl" || k === "Meta" ? "Mod" : k)).join("+").toLowerCase();

describe("TD10 shortcut registry", () => {
  afterEach(() => { setCrmScopeOn(false); setSingleKeysOff(false); });

  it("has no duplicate ids and no duplicate keys within a scope, CRM keys included", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
    const seen = new Map<string, string>();
    for (const c of COMMANDS.filter((x) => x.keys?.length && x.handler !== "local")) {
      const k = `${c.scope}:${c.sequence ? "seq:" : ""}${norm(c.keys!)}`;
      expect(seen.get(k), `${c.id} clashes with ${seen.get(k)}`).toBeUndefined();
      seen.set(k, c.id);
    }
    for (const c of crmCommands) expect(COMMANDS).toContain(c);
  });

  it("no command uses a chord the browser or a screen reader owns, or a plain arrow, Tab, Insert or Space", () => {
    const reserved = new Set(RESERVED_CHORDS.map(norm));
    for (const c of COMMANDS.filter((x) => x.keys?.length && !x.sequence)) {
      expect(reserved.has(norm(c.keys!)), c.id).toBe(false);
      if (c.keys!.length === 1 && c.handler !== "local") expect(RESERVED_SINGLE.includes(c.keys![0]), c.id).toBe(false);
    }
  });

  it("CRM keys live only on Contacts, Deals and Analyses, and only while CRM_TD10 is on", () => {
    expect(activeScopes("/app/contacts", noFocus)).not.toContain("crm");
    expect(sheetShortcuts().some((s) => s.group === "CRM")).toBe(false);
    expect(groupForPath("/app/contacts")).toBeUndefined();
    setCrmScopeOn(true);
    expect(activeScopes("/app/contacts", noFocus)[0]).toBe("crm");
    expect(activeScopes("/app/deals", noFocus)).toContain("crm");
    expect(activeScopes("/app/analyses", noFocus)).toContain("crm");
    expect(activeScopes("/app/mail", noFocus)).not.toContain("crm");
    expect(activeScopes("/app/contactsx", noFocus)).not.toContain("crm");
    expect(groupForPath("/app/analyses")).toBe("CRM");
    expect(sheetShortcuts().filter((s) => s.group === "CRM").map((s) => s.keys.join("+"))).toEqual(["J", "K", "A", "D", "N", "/", "Shift+S"]);
    const r = readKeys(idleKeys(), { key: "a" }, 0, activeScopes("/app/contacts", noFocus));
    expect(r.result.kind === "run" && r.result.command.id).toBe("crm-accept");
    const s = readKeys(idleKeys(), { key: "S", shiftKey: true }, 0, activeScopes("/app/contacts", noFocus));
    expect(s.result.kind === "run" && s.result.command.id).toBe("crm-suggestions");
  });

  it("the switch blocks single keys only: chords, Space and keys in menus and lists still work", () => {
    expect(singleKeysOff()).toBe(false);
    setSingleKeysOff(true);
    expect(singleKeysOff()).toBe(true);
    expect(isSingleKey({ key: "j" })).toBe(true);
    expect(isSingleKey({ key: "?" })).toBe(true);
    expect(isSingleKey({ key: "k", ctrlKey: true })).toBe(false);
    expect(isSingleKey({ key: "k", metaKey: true })).toBe(false);
    expect(isSingleKey({ key: " " })).toBe(false);
    expect(isSingleKey({ key: "Escape" })).toBe(false);
    expect(isSingleKey({ key: "ArrowDown" })).toBe(false);
    const inMenu = { closest: (sel: string) => (sel.includes('[role="menu"]') ? {} : null) } as unknown as EventTarget;
    expect(inKeyWidget(inMenu)).toBe(true);
    expect(inKeyWidget({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(inKeyWidget(null)).toBe(false);
  });
});
