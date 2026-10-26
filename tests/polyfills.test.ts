import { it, expect } from "vitest";
import { installPolyfills } from "@/web/lib/polyfills";

/** Sentry MYMAIL-WEB-2: Chrome Mobile 90 has no Array.prototype.at. */
it("adds .at() where an old browser lacks it, and leaves a native one alone", () => {
  class OldArray extends Array {}
  class OldString extends String {}
  Object.defineProperty(OldArray.prototype, "at", { value: undefined, configurable: true, writable: true });
  Object.defineProperty(OldString.prototype, "at", { value: undefined, configurable: true, writable: true });
  installPolyfills({ Array: OldArray as unknown as ArrayConstructor, String: OldString as unknown as StringConstructor });
  const a = OldArray.from([1, 2, 3]) as unknown as { at: (i: number) => unknown };
  expect(a.at(-1)).toBe(3);
  expect(a.at(0)).toBe(1);
  expect(a.at(5)).toBeUndefined();
  expect((new OldString("abc") as unknown as { at: (i: number) => unknown }).at(-1)).toBe("c");
  const native = Array.prototype.at;
  installPolyfills();
  expect(Array.prototype.at).toBe(native);
});
