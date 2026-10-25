/**
 * Builds a deployable Cloudflare Worker folder in dist/worker:
 *   dist/worker/_worker.js     the API (bundled), serving the SPA via ASSETS
 *   dist/worker/*              the built web app (static assets)
 *   dist/worker/tab-site.json  hosting declaration (D1 binding "DB")
 * Usage: tsx scripts/build-worker.ts [--profile preview] [--secrets <file>]
 *
 * --secrets reads KEY=VALUE lines (a .env file, or a notes file with "- KEY=VALUE"
 * lines) for hosts without a secret store. Only the keys in SECRET_KEYS are taken,
 * and they end up inside _worker.js only, which the host never serves as a file.
 * Never point it at a file that is committed.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { appCsp, securityHeaders } from "../src/server/lib/security-headers";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist/worker");
const profile = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : "default";

const release = process.env.RELEASE ?? process.env.GITHUB_SHA?.slice(0, 12) ?? gitSha();
function gitSha(): string {
  try { return execSync("git rev-parse --short=12 HEAD", { cwd: root }).toString().trim(); } catch { return "dev"; }
}

const PROFILES: Record<string, Record<string, string>> = {
  default: { RELEASE: release },
  // The public preview: real production mode (no fake data), sandbox demos enabled,
  // a secret generated and kept in D1 because the preview host has no secret store.
  preview: {
    APP_MODE: "production",
    DEMO_MODE: "true",
    APP_URL: process.env.PREVIEW_URL ?? "https://preview.multies.si",
    ALLOW_GENERATED_SECRET: "true",
    SENTRY_ENVIRONMENT: "preview",
    // The preview host has no cron trigger, so maintenance runs from requests there.
    MAINTENANCE_ON_REQUEST: "true",
    SECURITY_CONTACT: process.env.SECURITY_CONTACT ?? "mailto:contact@fintex.au",
    RELEASE: release,
  },
};
if (!PROFILES[profile]) throw new Error(`unknown profile ${profile}`);

const SECRET_KEYS = [
  "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS",
  "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "SENTRY_DSN_API", "SENTRY_DSN_WEB", "SENTRY_ENVIRONMENT",
  "PLATFORM_ADMIN_EMAILS", "SYSTEM_FROM", "SYSTEM_FROM_NAME", "DEPLOY_TOKEN",
];
const secretFiles = process.argv.flatMap((a, i) => (a === "--secrets" ? [process.argv[i + 1]] : []));
const secrets: Record<string, string> = {};
for (const file of secretFiles) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:-\s*)?`?([A-Z0-9_]+)=([^\s`]+)`?\s*$/);
    if (m && SECRET_KEYS.includes(m[1])) secrets[m[1]] = m[2];
  }
}
if (secretFiles.length) console.log(`secrets: ${Object.keys(secrets).join(", ") || "none found"}`);

if (!existsSync(path.join(root, "dist/web/index.html"))) throw new Error("Run `npm run build:web` first.");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(root, "dist/web"), out, { recursive: true });
// The app shell is served by the Worker (with its security headers), not as a static
// file: hosts that serve static files before the Worker would skip the headers.
const shellHtml = readFileSync(path.join(out, "index.html"), "utf8");
rmSync(path.join(out, "index.html"));
// Browser source maps go to Sentry (CI uploads them from dist/web), not to the public.
for (const f of readdirSync(path.join(out, "assets"))) if (f.endsWith(".map")) rmSync(path.join(out, "assets", f));

await build({
  entryPoints: [path.join(root, "src/entry/worker.ts")],
  outfile: path.join(out, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["worker", "browser"],
  // Node built-ins come from the runtime (nodejs_compat), not the bundle.
  external: ["node:*"],
  minify: true,
  // Production builds keep an external map for Sentry and wrangler (never served).
  sourcemap: profile === "preview" ? false : "external",
  alias: { "@": path.join(root, "src"), module: path.join(root, "src/server/shims/module.ts"), "@react-email/code-block": path.join(root, "src/server/shims/empty.ts") },
  define: { __MYMAIL_BUILD_ENV__: JSON.stringify({ ...PROFILES[profile], ...secrets }), __MYMAIL_SHELL_HTML__: JSON.stringify(shellHtml) },
  logLevel: "warning",
});

// Never serve the server bundle, its source map or the hosting declaration as static files.
writeFileSync(path.join(out, ".assetsignore"), "_worker.js\n_worker.js.map\ntab-site.json\n.assetsignore\n");

// Static assets are served by Cloudflare before the Worker runs, so their security
// headers come from a _headers file built from the same source as the API's.
const pageHeaders = securityHeaders({ csp: appCsp(), hsts: true });
writeFileSync(path.join(out, "_headers"), [
  "/*",
  ...Object.entries(pageHeaders).map(([k, v]) => `  ${k}: ${v}`),
  "/assets/*",
  "  cache-control: public, max-age=31536000, immutable",
  // Brand images are shown by other sites (the sign in page on the identity provider's
  // domain, mail clients), so they may be loaded cross origin. Everything else stays same origin.
  "/brand/*",
  "  ! cross-origin-resource-policy",
  "  cross-origin-resource-policy: cross-origin",
  "  access-control-allow-origin: *",
  "  cache-control: public, max-age=86400",
  "",
].join("\n"));

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
console.log(`worker built (${profile}) at ${path.relative(root, out)}`);
