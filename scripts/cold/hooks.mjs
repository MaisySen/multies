const SHIM = new URL("./shim-cf.mjs", import.meta.url).href;
export async function resolve(spec, ctx, next) {
  if (spec.startsWith("cloudflare:")) return { url: SHIM, shortCircuit: true };
  return next(spec, ctx);
}
