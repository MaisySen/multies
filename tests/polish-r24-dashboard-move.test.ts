import { it, expect } from "vitest";
import { moveWidget } from "@/web/pages/app/work/dashboard-move";

it("moves a widget up or down one place and leaves the ends alone", () => {
  const l = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ids = (x: { id: string }[]) => x.map((w) => w.id).join("");
  expect(ids(moveWidget(l, "b", -1))).toBe("bac");
  expect(ids(moveWidget(l, "b", 1))).toBe("acb");
  expect(moveWidget(l, "a", -1)).toBe(l);
  expect(moveWidget(l, "c", 1)).toBe(l);
  expect(moveWidget(l, "zz", 1)).toBe(l);
  expect(ids(l)).toBe("abc");
});
