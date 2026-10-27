import { describe, expect, it } from "vitest";
import { KEYBOARD_MIN_PX, keyboardInset } from "../src/web/lib/keyboard-inset";

describe("R49 keyboard inset", () => {
  it("is 0 with no keyboard", () => {
    expect(keyboardInset(844, 844)).toBe(0);
  });
  it("ignores the browser bars moving (under the threshold)", () => {
    expect(keyboardInset(844, 844 - (KEYBOARD_MIN_PX - 1))).toBe(0);
    expect(keyboardInset(844, 790)).toBe(0);
  });
  it("measures an open keyboard", () => {
    expect(keyboardInset(844, 508)).toBe(336);
  });
  it("takes the visual viewport offset into account (iOS pans the page)", () => {
    expect(keyboardInset(844, 508, 100)).toBe(236);
    expect(keyboardInset(844, 508, -20)).toBe(336);
  });
  it("is 0 for nonsense input", () => {
    expect(keyboardInset(0, 500)).toBe(0);
    expect(keyboardInset(844, 0)).toBe(0);
    expect(keyboardInset(Number.NaN, 400)).toBe(0);
  });
});
