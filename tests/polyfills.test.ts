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

/** R26: the classic /legacy.js runs before every module and shared chunk (index.html loads it first). */
it("public/legacy.js adds .at() on a window that lacks it, and index.html loads it before the app module", async () => {
  const { readFileSync } = await import("node:fs");
  const { runInNewContext } = await import("node:vm");
  const src = readFileSync("public/legacy.js", "utf8");
  const sandbox: Record<string, unknown> = {};
  runInNewContext("delete Array.prototype.at; delete String.prototype.at; delete Uint8Array.prototype.at; window = globalThis;" + src + "; result = [[1, 2, 3].at(-1), 'abc'.at(0), new Uint8Array([7, 8]).at(-1), [1].at(4)];", sandbox);
  expect(sandbox.result).toEqual([3, "a", 8, undefined]);
  const html = readFileSync("index.html", "utf8");
  expect(html.indexOf('src="/legacy.js"')).toBeGreaterThan(-1);
  expect(html.indexOf('src="/legacy.js"')).toBeLessThan(html.indexOf('type="module"'));
});
