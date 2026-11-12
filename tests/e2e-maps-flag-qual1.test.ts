import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * QUAL1 (review of the CI repair): the maplibre-gl 5 to 6 bump is checked end to end only by
 * e2e/maps-worker-qual1.spec.ts, which skips itself unless the e2e server runs with MAPS_R115=on, and
 * e2e/maps-r115.spec.ts needs MAPS_R115=on MAPS_GEO_MOCK=1 (its header says so). npm run test:e2e (the CI step) starts
 * the server from playwright.config.ts, so without both flags there the map check is skipped in CI and the three R115
 * map tests fail before they reach a map.
 */
describe("the e2e server runs the map checks", () => {
  const config = readFileSync("playwright.config.ts", "utf8");
  const main = config.slice(config.indexOf("webServer"), config.indexOf("src/entry/node.ts"));

  it("the map specs say they need MAPS_R115=on and MAPS_GEO_MOCK=1 on the e2e server", () => {
    expect(readFileSync("e2e/maps-r115.spec.ts", "utf8")).toContain("MAPS_R115=on MAPS_GEO_MOCK=1 in the e2e server");
    expect(readFileSync("e2e/maps-worker-qual1.spec.ts", "utf8")).toContain('test.skip((await (await page.request.get("/api/config")).json()).maps !== true');
  });

  it("playwright.config.ts starts the e2e server with the maps flag and the offline address lookup", () => {
    expect(main).toMatch(/\bMAPS_R115=(on|1|true)\b/);
    expect(main).toMatch(/\bMAPS_GEO_MOCK=1\b/);
  });
});
