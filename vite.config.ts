import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // Hidden source maps: uploaded to Sentry by CI, never referenced or served.
  build: { outDir: "dist/web", emptyOutDir: true, sourcemap: "hidden" },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
