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
import { build, type BuildOptions, type Plugin } from "esbuild";
import { builtinModules } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
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
  "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS", "STRIPE_PORTAL_CONFIG",
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
// R46: the v1 OpenAPI document, built here once instead of in a cold isolate (266 to 413 ms of CPU on production).
// The Worker serves it with the request's origin in place of the placeholder (src/entry/worker.ts).
{
  const { v1Routes, buildOpenApiText, OPENAPI_ORIGIN_PLACEHOLDER } = await import("../src/server/routes/v1");
  mkdirSync(path.join(out, "_spec"), { recursive: true });
  writeFileSync(path.join(out, "_spec/openapi-v1.json"), buildOpenApiText(v1Routes(), OPENAPI_ORIGIN_PLACEHOLDER));
}
// The app shell is served by the Worker (with its security headers), not as a static
// file: hosts that serve static files before the Worker would skip the headers.
const shellHtml = readFileSync(path.join(out, "index.html"), "utf8");
rmSync(path.join(out, "index.html"));
// R30: the prerendered landing (npm run build:web makes it) is served by the Worker for "/" too.
const landingFile = path.join(out, "landing.html");
const landingHtml = existsSync(landingFile) ? readFileSync(landingFile, "utf8") : "";
rmSync(landingFile, { force: true });
const authFile = path.join(out, "auth.html");
const authHtml = existsSync(authFile) ? readFileSync(authFile, "utf8") : "";
rmSync(authFile, { force: true });
// R76: the prerendered public pages (pricing, legal, developers...), one HTML per path.
const publicFile = path.join(out, "public-pages.json");
const publicPages = existsSync(publicFile) ? JSON.parse(readFileSync(publicFile, "utf8")) : null;
rmSync(publicFile, { force: true });
// R34 (perf2): the prerendered sign in cards (one per setup); the Worker picks one per request, so not a static file.
const loginFile = path.join(out, "auth-login.json");
const loginPrerender = existsSync(loginFile) ? JSON.parse(readFileSync(loginFile, "utf8")) : null;
rmSync(loginFile, { force: true });
// Browser source maps go to Sentry (CI uploads them from dist/web), not to the public.
for (const f of readdirSync(path.join(out, "assets"))) if (f.endsWith(".map")) rmSync(path.join(out, "assets", f));

// Libraries written for Node (ImapFlow, Nodemailer's composer) import or require bare built-ins ("net",
// "tls", "events"); on Workers those come from nodejs_compat under their node: names. An ESM bundle has no
// require(), so esbuild's require shim would throw "Dynamic require of node:events is not supported" at
// startup (seen in wrangler dev, 25 Oct 2026). The first pass finds which built-ins are required; the
// banner imports them statically and gives the bundle a require() that hands them out.
const builtinNames = new Set(builtinModules.filter((m) => !m.startsWith("_") && !m.includes("/") && m !== "module" && m !== "punycode"));
const required = new Set<string>();
const nodeBuiltins: Plugin = {
  name: "node-builtins",
  setup(b) {
    b.onResolve({ filter: /^(node:)?[a-z_]+(\/[a-z_]+)?$/ }, (args) => {
      const bare = args.path.replace(/^node:/, "");
      if (!builtinNames.has(bare.split("/")[0])) return undefined;
      if (args.kind === "require-call") required.add(bare);
      return { path: `node:${bare}`, external: true };
    });
  },
};
// STB1 (startup budget): the prerendered public pages (about 3.6 MB of HTML) and sign in cards used to be JSON
// defines, which the bundler turns into one big object literal built at Worker startup (about 10 ms of startup
// CPU). They are now an injected module with the same shape, where every long string is a getter: each page's
// HTML is made the first time that page is read, and reads give exactly the same values as before.
function lazyLiteral(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(lazyLiteral).join(", ")}]`;
  return `{ ${Object.entries(value as Record<string, unknown>).map(([k, v]) =>
    typeof v === "string" && v.length >= 1024 ? `get ${JSON.stringify(k)}() { return ${JSON.stringify(v)}; }` : `${JSON.stringify(k)}: ${lazyLiteral(v)}`,
  ).join(", ")} }`;
}
const injectDir = mkdtempSync(path.join(tmpdir(), "mymail-prerender-"));
const prerenderInject = path.join(injectDir, "prerender-inject.js");
writeFileSync(prerenderInject, [
  `export const __mymailPublicHtml = ${lazyLiteral(publicPages)};`,
  `export const __mymailLoginPrerender = ${lazyLiteral(loginPrerender)};`,
  "",
].join("\n"));
// The injected values must read back exactly as the JSON they replace (same keys, order and strings).
{
  const injected = await import(pathToFileURL(prerenderInject).href) as { __mymailPublicHtml: unknown; __mymailLoginPrerender: unknown };
  if (JSON.stringify(injected.__mymailPublicHtml) !== JSON.stringify(publicPages) || JSON.stringify(injected.__mymailLoginPrerender) !== JSON.stringify(loginPrerender)) {
    throw new Error("prerendered pages: the injected module does not match the prerendered JSON");
  }
}
const options = (banner: string): BuildOptions => ({
  entryPoints: [path.join(root, "src/entry/worker.ts")],
  outfile: path.join(out, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["worker", "browser"],
  external: ["node:*", "cloudflare:*"],
  plugins: [nodeBuiltins],
  banner: { js: banner },
  minify: true,
  // Production builds keep an external map for Sentry and wrangler (never served).
  sourcemap: profile === "preview" ? false : "external",
  alias: { "@": path.join(root, "src"), module: path.join(root, "src/server/shims/module.ts"), "@react-email/code-block": path.join(root, "src/server/shims/empty.ts") },
  define: { __MYMAIL_BUILD_ENV__: JSON.stringify({ ...PROFILES[profile], ...secrets }), __MYMAIL_SHELL_HTML__: JSON.stringify(shellHtml), __MYMAIL_LANDING_HTML__: JSON.stringify(landingHtml), __MYMAIL_AUTH_HTML__: JSON.stringify(authHtml), __MYMAIL_LOGIN_PRERENDER__: "__mymailLoginPrerender", __MYMAIL_PUBLIC_HTML__: "__mymailPublicHtml" },
  inject: [prerenderInject],
  logLevel: "warning",
});
await build({ ...options(""), write: false });
const names = [...required].sort();
const banner = names.length ? [
  ...names.map((n, i) => `import * as __nb${i} from "node:${n}";`),
  `const __nodeBuiltins = { ${names.map((n, i) => `${JSON.stringify(n)}: __nb${i}`).join(", ")} };`,
  "const require = (n) => { const m = __nodeBuiltins[String(n).replace(/^node:/, \"\")]; if (!m) throw new Error(\"Module not available on Workers: \" + n); return m.default ?? m; };",
].join("\n") : "";
try { await build(options(banner)); } finally { rmSync(injectDir, { recursive: true, force: true }); }
if (names.length) console.log(`node built-ins required by bundled libraries: ${names.join(", ")}`);

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
  // R32: the service worker is always checked for a newer copy, so a deploy reaches every open tab.
  "/sw.js",
  "  cache-control: no-cache",
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
