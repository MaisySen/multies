/**
 * Small polyfills for older phone browsers (Sentry issue WEB-2, Chrome Mobile 90: "this.o.at is not a
 * function"). Array, string and typed array .at() arrived in Chrome 92 and Safari 15.4. Imported first in
 * main.tsx so it runs before any library code.
 */

// W4: Zod 4 checks once whether it may compile validators with `new Function("")`. Our CSP has no
// 'unsafe-eval', so that probe is refused and reported as a securitypolicyviolation (and to Sentry) even
// though Zod catches it. `jitless` (zod/v4/core: globalConfig, read from globalThis.__zod_globalConfig)
// skips the probe and the compiled fast path. It must be set before any schema is built: Zod is only in
// lazily loaded chunks, which load after this file has run.
const zodScope = globalThis as { __zod_globalConfig?: Record<string, unknown> };
zodScope.__zod_globalConfig = Object.assign(zodScope.__zod_globalConfig || {}, { jitless: true });

function at(this: { length: number; [i: number]: unknown }, index: number) {
  const n = Math.trunc(Number(index)) || 0;
  const i = n < 0 ? this.length + n : n;
  return i < 0 || i >= this.length ? undefined : this[i];
}

export function installPolyfills(scope: { Array: ArrayConstructor; String: StringConstructor; [k: string]: unknown } = globalThis as never) {
  const targets: { prototype: object }[] = [scope.Array, scope.String];
  for (const name of ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]) {
    const t = scope[name] as { prototype: object } | undefined;
    if (t) targets.push(t);
  }
  for (const t of targets) {
    if (typeof (t.prototype as { at?: unknown }).at !== "function") {
      Object.defineProperty(t.prototype, "at", { value: at, writable: true, enumerable: false, configurable: true });
    }
  }
}

installPolyfills();
