import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// R25: big libraries get chunks of their own, so an app release does not change their hashes (they stay
// cached) and a page downloads only the libraries it uses. Only libraries the pages already load lazily
// are named here, plus React, which every page needs.
const lib = (names: string) => new RegExp(`[\\/]node_modules[\\/](${names})[\\/]`);
const VENDOR_GROUPS = [
  { name: "vendor-react", test: lib("react|react-dom|scheduler|react-router"), priority: 30 },
  // The editor and its co-editing layer share one chunk: split apart, their circular imports ran out of order.
  // R32: fast-equals (used by @tiptap/react) belongs here too; left out, it landed in an app chunk that imports
  // the editor, the two chunks imported each other, and the docs blocks crashed on load (Node undefined).
  { name: "vendor-editor", test: lib("@tiptap|prosemirror-[a-z-]+|linkifyjs|orderedmap|rope-sequence|w3c-keyname|yjs|lib0|y-protocols|y-websocket|fast-equals"), priority: 20 },
  { name: "vendor-charts", test: lib("recharts|d3-[a-z-]+|victory-vendor|decimal\\.js-light|@reduxjs|react-redux|redux|immer|reselect|es-toolkit"), priority: 20 },
  { name: "vendor-calls", test: lib("livekit-client|@livekit"), priority: 20 },
  // R35: FullCalendar 7 brings its headless core and the Temporal polyfill; all three in one chunk, or their
  // imports run across chunks out of order ("is not a constructor" on load).
  { name: "vendor-calendar", test: lib("@fullcalendar|@full-ui|temporal-polyfill|temporal-spec|temporal-utils|preact"), priority: 20 },
  { name: "vendor-gantt", test: lib("@svar-ui"), priority: 20 },
  { name: "vendor-dnd", test: lib("@dnd-kit"), priority: 20 },
  { name: "vendor-sentry", test: lib("@sentry|@sentry-internal"), priority: 20 },
  // R40 (MB-203): the glyphs the build keeps (tree shaken, about 38 KB gzip) ride in ONE chunk with the icon base.
  // Split per page they came out as about 120 files of 300 bytes each, and on a slow phone network every file
  // costs a round trip: My Work alone waited on 50 of them. Pure modules, no imports back into app code.
  { name: "icons", test: /[\\/]src[\\/]web[\\/]components[\\/]ui[\\/](icons[\\/]|icon\.tsx|icon-base\.tsx)/, priority: 10 },
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // R73: the build's own release, so a page file that fails to load can tell a new release (reload once) from a bad
  // connection (show Retry) by comparing with /version.json (src/web/lib/page-load.ts).
  define: { __WEB_RELEASE__: JSON.stringify(process.env.RELEASE?.trim() ?? "") },
  // Hidden source maps: uploaded to Sentry by CI, never referenced or served.
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: "hidden",
    // R30: read by scripts/prerender-landing.ts (route preloads for sign in), then deleted from dist.
    manifest: true,
    rolldownOptions: {
      output: { codeSplitting: { includeDependenciesRecursively: false, groups: VENDOR_GROUPS } },
      // R35: the icon modules are pure, so the icon barrel does not pull every glyph into the first chunk; each
      // page chunk carries only the glyphs it uses (docs/design/premium-pass-2.md).
      treeshake: { moduleSideEffects: (id: string) => !/[\\/]components[\\/]ui[\\/](icons[\\/]|icon\.tsx|icon-base\.tsx)/.test(id) },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
