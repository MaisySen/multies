
import { build } from "esbuild";
import { builtinModules } from "node:module";
import path from "node:path";
const root = process.cwd(); // run from the checkout (R44: was a fixed R42 path)
const minify = process.argv.includes("--minify");
const outfile = process.argv[2];
const builtinNames = new Set(builtinModules.filter((m) => !m.startsWith("_") && !m.includes("/") && m !== "module" && m !== "punycode"));
const required = new Set();
const nodeBuiltins = { name: "node-builtins", setup(b) { b.onResolve({ filter: /^(node:)?[a-z_]+(\/[a-z_]+)?$/ }, (args) => {
  const bare = args.path.replace(/^node:/, ""); if (!builtinNames.has(bare.split("/")[0])) return undefined;
  if (args.kind === "require-call") required.add(bare); return { path: `node:${bare}`, external: true }; }); } };
const opts = (banner) => ({
  entryPoints: [path.join(root, "src/entry/worker.ts")], outfile, bundle: true, format: "esm", platform: "browser", target: "es2022",
  conditions: ["worker", "browser"], external: ["node:*", "cloudflare:*"], plugins: [nodeBuiltins], banner: { js: banner }, minify,
  metafile: true, logLevel: "warning",
  alias: { "@": path.join(root, "src"), module: path.join(root, "src/server/shims/module.ts"), "@react-email/code-block": path.join(root, "src/server/shims/empty.ts") },
  define: { __MYMAIL_BUILD_ENV__: JSON.stringify({ RELEASE: "cold" }), __MYMAIL_SHELL_HTML__: '""', __MYMAIL_LANDING_HTML__: '""', __MYMAIL_AUTH_HTML__: '""', __MYMAIL_LOGIN_PRERENDER__: "null" },
});
await build({ ...opts(""), write: false });
const names = [...required].sort();
const banner = names.length ? [...names.map((n, i) => `import * as __nb${i} from "node:${n}";`),
  `const __nodeBuiltins = { ${names.map((n, i) => `${JSON.stringify(n)}: __nb${i}`).join(", ")} };`,
  "const require = (n) => { const m = __nodeBuiltins[String(n).replace(/^node:/, \"\")]; if (!m) throw new Error(\"Module not available on Workers: \" + n); return m.default ?? m; };"].join("\n") : "";
const r = await build(opts(banner));
const fs = await import("node:fs");
fs.writeFileSync(outfile + ".meta.json", JSON.stringify(r.metafile));
console.log("built", outfile, fs.statSync(outfile).size);
