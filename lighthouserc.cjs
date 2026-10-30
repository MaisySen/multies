/**
 * Lighthouse CI: runs Lighthouse three times on each public page against a local
 * production build and fails CI when a budget is broken.
 *   npm run build && npm run lhci
 */
module.exports = {
  ci: {
    collect: {
      startServerCommand: "rm -f .data/lhci.db && PORT=8790 DATABASE_PATH=.data/lhci.db APP_URL=http://localhost:8790 node dist/server/node.js",
      startServerReadyPattern: "mymail",
      url: ["http://localhost:8790/", "http://localhost:8790/pricing", "http://localhost:8790/login", "http://localhost:8790/status", "http://localhost:8790/privacy"],
      numberOfRuns: 3,
      settings: { preset: "desktop", chromeFlags: "--no-sandbox --headless=new" },
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9 }],
        "categories:accessibility": ["error", { minScore: 0.95 }],
        "categories:best-practices": ["error", { minScore: 0.9 }],
        "categories:seo": ["error", { minScore: 0.9 }],
        "largest-contentful-paint": ["error", { maxNumericValue: 2500 }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.1 }],
        "total-blocking-time": ["error", { maxNumericValue: 200 }],
        "resource-summary:script:size": ["error", { maxNumericValue: 200000 }],
        "resource-summary:total:size": ["error", { maxNumericValue: 600000 }],
      },
    },
    upload: { target: "filesystem", outputDir: ".lighthouseci" },
  },
};
