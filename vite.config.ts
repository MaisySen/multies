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
  { name: "vendor-editor", test: lib("@tiptap|prosemirror-[a-z-]+|linkifyjs|orderedmap|rope-sequence|w3c-keyname|yjs|lib0|y-protocols|y-websocket"), priority: 20 },
  { name: "vendor-charts", test: lib("recharts|d3-[a-z-]+|victory-vendor|decimal\\.js-light|@reduxjs|react-redux|redux|immer|reselect|es-toolkit"), priority: 20 },
  { name: "vendor-calls", test: lib("livekit-client|@livekit"), priority: 20 },
  { name: "vendor-calendar", test: lib("@fullcalendar|preact"), priority: 20 },
  { name: "vendor-gantt", test: lib("@svar-ui"), priority: 20 },
  { name: "vendor-dnd", test: lib("@dnd-kit"), priority: 20 },
  { name: "vendor-sentry", test: lib("@sentry|@sentry-internal"), priority: 20 },
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // Hidden source maps: uploaded to Sentry by CI, never referenced or served.
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: "hidden",
    // R30: read by scripts/prerender-landing.ts (route preloads for sign in), then deleted from dist.
    manifest: true,
    rolldownOptions: { output: { codeSplitting: { includeDependenciesRecursively: false, groups: VENDOR_GROUPS } } },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
