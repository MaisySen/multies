import { describe, it, expect } from "vitest";
import { paletteScore } from "@/web/lib/palette-registry";
import { COMMANDS } from "@/web/lib/commands/registry";

// F13: Ctrl K best match first (MB-300, MB-301, MB-317) and the R121 page names (bug 4).
const best = (q: string) => {
  // The menu's own list (what Ctrl K shows), ids without their "nav-" prefix.
  const ranked = COMMANDS.map((c) => ({ id: c.id.replace(/^nav-/, ""), s: paletteScore(`${c.title}|${c.id}`, q, c.keywords) })).filter((x) => x.s > 0);
  ranked.sort((a, b) => b.s - a.s); // stable, like the menu: equal scores keep registry order
  return ranked.map((x) => x.id);
};

describe("F13 command menu ranking", () => {
  it("puts Ask AI under every match", () => {
    for (const q of ["settings", "invoice", "vault", "form", "people"]) expect(paletteScore(`${q}|ask-ai`, q)).toBe(0.01);
  });
  it("the page named by the word wins", () => {
    expect(["p-settings", "go-s"]).toContain(best("settings")[0]);
    expect(best("invoice")[0]).toBe("p-invoices");
    expect(best("vault")[0]).toBe("p-tools-vault");
    expect(best("form")[0]).toBe("p-forms");
  });
  it("finds the R121 homes and the asked for words", () => {
    expect(best("people")[0]).toBe("p-people");
    expect(best("deals")[0]).toBe("p-deals");
    expect(best("mail setup")[0]).toBe("p-mail-setup");
    expect(best("webinar").some((id) => id === "p-meetings" || id === "go-m")).toBe(true); // "Go to Meetings" is the menu's Meetings entry
    expect(best("office")).toEqual(expect.arrayContaining(["p-tools-convert", "p-files"]));
    expect(best("widget")[0]).toBe("p-home-widgets");
  });
  it("an unmatched Nepali query matches no page, only the Ask AI fallback (qa9 MB-275)", () => {
    expect(best("कार्य सूची")).toEqual([]);
    expect(paletteScore("कार्य सूची|ask-ai", "कार्य सूची")).toBe(0.01);
  });
});
