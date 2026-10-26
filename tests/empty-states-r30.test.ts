import { describe, expect, it } from "vitest";
import { emptyTasksCopy, hasTaskFilters } from "@/web/lib/empty-states";
import { skeletonWidths } from "@/web/lib/skeleton";

const KEYS = ["q", "assignee", "priority", "label", "status", "type"] as const;

describe("R30 empty task views", () => {
  it("filters in the address count; other params do not", () => {
    expect(hasTaskFilters(new URLSearchParams("view=list&project=p1").entries(), KEYS)).toBe(false);
    expect(hasTaskFilters(new URLSearchParams("view=list&assignee=me").entries(), KEYS)).toBe(true);
    expect(hasTaskFilters(new URLSearchParams("field.f1=x").entries(), KEYS)).toBe(true);
    expect(hasTaskFilters(new URLSearchParams("q=").entries(), KEYS)).toBe(false);
  });

  it("a filtered view offers Clear filters", () => {
    const c = emptyTasksCopy("list", true);
    expect(c).toMatchObject({ action: "clear", actionLabel: "Clear filters" });
  });

  it("an empty list offers New task; the calendar explains due dates", () => {
    expect(emptyTasksCopy("list", false)).toMatchObject({ action: "new", actionLabel: "New task" });
    expect(emptyTasksCopy("calendar", false).action).toBeNull();
    expect(emptyTasksCopy("calendar", false).body).toContain("due date");
  });

  it("copy has no dashes", () => {
    for (const v of ["list", "calendar"] as const) for (const f of [true, false]) {
      const c = emptyTasksCopy(v, f);
      expect(`${c.title} ${c.body}`).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("R30 skeleton rows", () => {
  it("are stable, varied and bounded", () => {
    expect(skeletonWidths(3)).toEqual(skeletonWidths(3));
    expect(new Set(skeletonWidths(7)).size).toBe(7);
    expect(skeletonWidths(0)).toEqual([]);
    expect(skeletonWidths(500).length).toBe(50);
    expect(skeletonWidths(-2)).toEqual([]);
  });
});
