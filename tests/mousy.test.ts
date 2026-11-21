import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isKnownPage } from "../src/shared/known-routes";
import { metaFor } from "../src/web/components/seo-meta";

describe("Mousy is a Multies feature with a complete download journey", () => {
  it("has a known route and its own title", () => {
    expect(isKnownPage("/mousy")).toBe(true);
    expect(isKnownPage("/mousy/")).toBe(true);
    expect(metaFor("/mousy").title).toBe("Mousy: hands-free pointing for Mac | Multies");
  });
  it("pins the verified replacement build and its privacy behaviour", () => {
    const page = readFileSync("src/web/pages/mousy.tsx", "utf8");
    expect(page).toContain("f40aca73a37b57be1523c3067fe369bbc750bb4233b22ba53e404eb02ba123ac");
    expect(page).toContain("off by default behind separate toggles");
    expect(page).toContain("nothing is sent unless you opt in");
    expect(page).toContain("Real head tracking still needs testing");
    expect(page).toContain("not notarized");
    expect(page).toContain("Do not turn off Gatekeeper");
  });
  it("keeps motion and permissions local, not a web pairing flow", () => {
    const page = readFileSync("src/web/pages/mousy.tsx", "utf8");
    expect(page).toContain("A native Mac app is needed");
    expect(page).toContain("not this device");
    expect(page).toContain("Multies / Features");
    expect(readFileSync("src/web/pages/app/apps-settings.tsx", "utf8")).toContain('to="/mousy"');
  });
});
