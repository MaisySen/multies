import { describe, expect, it } from "vitest";
import { isJump } from "@/web/lib/use-windowed-list";

describe("R45 isJump (light cards while a column is jump scrolled)", () => {
  it("a normal scroll is not a jump", () => {
    expect(isJump(0, 100, 640)).toBe(false); // a trackpad frame
    expect(isJump(5000, 4400, 640)).toBe(false); // Page Up sized (600 of a 640 px box)
    expect(isJump(null, 90000, 640)).toBe(false); // the first reading
  });
  it("more than one screen in one frame is", () => {
    expect(isJump(0, 6600, 640)).toBe(true); // the 90 frame jump test over 594k px
    expect(isJump(0, 1070, 700)).toBe(true); // the swimlane board jump (96k px page in 90 frames)
    expect(isJump(480000, 0, 640)).toBe(true); // Home
  });
  it("small boxes still need at least 400 px", () => {
    expect(isJump(0, 390, 200)).toBe(false);
    expect(isJump(0, 401, 200)).toBe(true);
  });
});
