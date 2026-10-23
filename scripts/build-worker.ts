/**
 * Builds a deployable Cloudflare Worker folder in dist/worker:
 *   dist/worker/_worker.js     the API (bundled), serving the SPA via ASSETS
 *   dist/worker/*              the built web app (static assets)
 *   dist/worker/tab-site.json  hosting declaration (D1 binding "DB")
 * Usage: tsx scripts/build-worker.ts [--profile preview]
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist/worker");
const profile = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : "default";

const PROFILES: Record<string, Record<string, string>> = {
  default: {},
  // The public preview: real production mode (no fake data), sandbox demos enabled,
  // a secret generated and kept in D1 because the preview host has no secret store.
  preview: {
    APP_MODE: "production",
    DEMO_MODE: "true",
    APP_URL: process.env.PREVIEW_URL ?? "https://mymail.sites.tab.bot",
    ALLOW_GENERATED_SECRET: "true",
  },
};
if (!PROFILES[profile]) throw new Error(`unknown profile ${profile}`);

if (!existsSync(path.join(root, "dist/web/index.html"))) throw new Error("Run `npm run build:web` first.");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "dist/web"), out, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/entry/worker.ts")],
  outfile: path.join(out, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["worker", "browser"],
  minify: true,
  sourcemap: false,
  alias: { "@": path.join(root, "src") },
  define: { __MYMAIL_BUILD_ENV__: JSON.stringify(PROFILES[profile]) },
  logLevel: "warning",
});

writeFileSync(path.join(out, "tab-site.json"), JSON.stringify({
  kind: "worker",
  entry: "_worker.js",
  bindings: [{ type: "d1", name: "DB" }],
  worker: {
    compatibility_date: "2026-08-01",
    compatibility_flags: ["nodejs_compat"],
    html_handling: "auto-trailing-slash",
    not_found_handling: "none",
    assets_binding: "ASSETS",
  },
}, null, 2));
console.log(`worker built (${profile}) → ${path.relative(root, out)}`);
