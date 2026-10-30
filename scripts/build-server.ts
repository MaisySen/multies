/** Bundles the Node server into dist/server/node.js (dependencies stay external). */
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
await build({
  entryPoints: [path.join(root, "src/entry/node.ts")],
  outfile: path.join(root, "dist/server/node.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  alias: { "@": path.join(root, "src") },
  logLevel: "warning",
});
console.log("server built → dist/server/node.js");
