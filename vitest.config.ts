import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      include: ["src/server/**/*.ts", "src/shared/**/*.ts", "src/emails/**/*.tsx", "email-worker/src/**/*.ts"],
      exclude: ["src/server/db/migrations.generated.ts", "src/server/services/dns/node-resolver.ts"],
      reporter: ["text-summary", "json-summary", "html", "lcov"],
      reportsDirectory: "coverage",
      // The floor only moves up. Raise it when coverage rises.
      thresholds: { lines: 85, functions: 78, branches: 65, statements: 82 },
    },
  },
});
