import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** R124: on the deployed worker the static assets layer answers first, so every script the app serves itself
 *  must be in the worker gate in src/entry/worker.ts (staging 478d247 answered /site-assets/blog.js with a 404 page). */
describe("R124 worker gate", () => {
  it("sends the public blog subscribe script to the app", () => {
    const src = readFileSync(new URL("../src/entry/worker.ts", import.meta.url), "utf8");
    expect(src).toContain('url.pathname === "/site-assets/blog.js"');
    expect(src).toContain('url.pathname === "/site-assets/comments.js"');
  });
});
