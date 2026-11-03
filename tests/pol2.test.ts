import { describe, it, expect } from "vitest";
import { BASE, PRESETS, colourTokens, contrast, pressFill, readableOn } from "@/shared/branding";
import { BUILTIN_TOURS, desktopOnlySteps, hiddenOnPhone, stepsLabel } from "@/shared/tours-r130";
import { breadcrumbs, pageTitle } from "@/web/layouts/shell-nav";

/** POL2 polish round: hover contrast token, tour step counts and phone hints (MB-327, MB-329), Staff titles. */

describe("filled button hover keeps its text readable (dark hover was 4.41:1)", () => {
  it("Multies' own colours: rest and hover both at least 4.5:1, in light and dark", () => {
    // The fixed tokens in index.css: light #0066cc / #0058b0, dark #0071e3 / #0063c7.
    for (const [fill, press] of [["#0066cc", "#0058b0"], ["#0071e3", "#0063c7"]]) {
      expect(contrast(fill, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(press, "#ffffff")).toBeGreaterThan(contrast(fill, "#ffffff"));
    }
    expect(BASE.light.brand).toBe("#0066cc");
    expect(BASE.dark.brand).toBe("#0071e3");
  });
  it("every preset (Forest included) and odd brand colours: hover moves away from the text, never under 4.5:1", () => {
    const colours = [...PRESETS.map((p) => p.primary), "#ffd400", "#ffffff", "#000000", "#2b8c50", "#e11d48"];
    for (const scheme of ["light", "dark"] as const) {
      for (const c of colours) {
        const t = colourTokens(c, null, scheme);
        const fill = t["--color-brand"], press = t["--color-brand-press"], fg = t["--color-brand-fg"];
        expect(press, `${c} ${scheme}`).toBe(pressFill(fill));
        expect(fg).toBe(readableOn(fill));
        expect(contrast(fill, fg), `${c} ${scheme} rest`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(press, fg), `${c} ${scheme} hover`).toBeGreaterThanOrEqual(contrast(fill, fg));
      }
    }
    expect(PRESETS.some((p) => p.id === "forest")).toBe(true);
  });
});

describe("tours (MB-327, MB-329)", () => {
  it("says 1 step and 2 steps", () => {
    expect(stepsLabel(0)).toBe("0 steps");
    expect(stepsLabel(1)).toBe("1 step");
    expect(stepsLabel(2)).toBe("2 steps");
    const more = BUILTIN_TOURS.find((t) => t.id === "builtin:more_sheet")!;
    expect(stepsLabel(more.steps.length)).toBe("1 step");
  });
  it("marks steps that point at the side rail or sidebar as not shown on phones", () => {
    expect(hiddenOnPhone("rail-home")).toBe(true);
    expect(hiddenOnPhone("nav-app-contacts")).toBe(true);
    expect(hiddenOnPhone("sidebar-account")).toBe(true);
    expect(hiddenOnPhone("tab-more")).toBe(false);
    expect(hiddenOnPhone("topbar-account")).toBe(false);
    expect(hiddenOnPhone("pane-app-settings-mail")).toBe(false);
    expect(hiddenOnPhone("my-rail-thing")).toBe(false);
  });
  it("a members tour whose only step is on the rail is computers and tablets only; one phone step is enough to show it", () => {
    expect(desktopOnlySteps([])).toBe(false);
    expect(desktopOnlySteps([{ target: "rail-docs" }])).toBe(true);
    expect(desktopOnlySteps([{ target: "rail-docs" }, { target: "nav-app-files" }])).toBe(true);
    expect(desktopOnlySteps([{ target: "rail-docs" }, { target: "tab-more" }])).toBe(false);
    // The built in tours agree with the rule they were hand marked with in R130.
    for (const t of BUILTIN_TOURS.filter((x) => x.desktopOnly)) expect(t.steps.some((s) => hiddenOnPhone(s.target))).toBe(true);
  });
});

describe("Staff pages name themselves (R126 low)", () => {
  it("crumbs and tab title say Staff, asset pages say Staff then Assets", () => {
    expect(breadcrumbs("/app/contacts/staff", "").map((c) => c.label).slice(-1)).toEqual(["Staff"]);
    expect(breadcrumbs("/app/contacts/staff/u_1", "").map((c) => c.label).slice(-1)).toEqual(["Staff"]);
    expect(breadcrumbs("/app/contacts/assets/a_1", "").map((c) => c.label).slice(-2)).toEqual(["Staff", "Assets"]);
    expect(pageTitle("/app/contacts/staff")).toBe("Staff · Multies");
    expect(pageTitle("/app/contacts/staff", "?view=org")).toBe("Staff · Multies");
    // Contacts itself is unchanged, and the Staff crumb links back to the directory.
    expect(breadcrumbs("/app/contacts", "").map((c) => c.label).at(-1)).not.toBe("Staff");
    expect(breadcrumbs("/app/contacts/assets/a_1", "").find((c) => c.label === "Staff")?.to).toBe("/app/contacts/staff");
  });
});
