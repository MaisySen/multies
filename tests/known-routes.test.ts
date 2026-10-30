import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isKnownPage } from "../src/shared/known-routes";

describe("isKnownPage", () => {
  it("knows the public and app pages", () => {
    for (const p of ["/", "/pricing", "/pricing/", "/login", "/app", "/app/chat/chn_1", "/app/goals", "/invite/abc", "/f/form1", "/guest"]) expect(isKnownPage(p), p).toBe(true);
  });
  it("answers unknown pages as not found", () => {
    for (const p of ["/nope", "/application", "/invite/", "/pricingx", "/wp-admin"]) expect(isKnownPage(p), p).toBe(false);
  });
  it("covers every top level page in the router", () => {
    const router = readFileSync("src/web/router.tsx", "utf8");
    const top = [...router.matchAll(/\{ path: "([a-z-]+)"/g)].map((m) => m[1]).filter((x) => !router.includes(`path: "app"`) || x !== "app");
    const publicPaths = top.filter((x) => isKnownPage(`/${x}`) || isKnownPage(`/app/${x}`));
    expect(publicPaths.length).toBe(top.length);
  });
});
