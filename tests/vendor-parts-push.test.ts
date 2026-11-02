import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { SCALAR_ASSET } from "../src/server/lib/security-headers";

// The API reference renderer is too large for one request to the code host, so it is stored as gzip parts
// and rebuilt by scripts/restore-vendor.mjs at build time. These checks keep that round trip exact.
const dir = new URL("../vendor/scalar/", import.meta.url);
const name = SCALAR_ASSET.split("/").pop()!;

describe("vendored API reference parts", () => {
  it("rebuild the exact file named by the policy, from parts each under 1 MB", () => {
    const parts = readdirSync(dir).filter((f) => f.startsWith(`${name}.gz.part`)).sort();
    expect(parts.length).toBeGreaterThan(0);
    const bufs = parts.map((p) => readFileSync(new URL(p, dir)));
    for (const b of bufs) expect(b.length).toBeLessThan(1024 * 1024);
    const data = gunzipSync(Buffer.concat(bufs));
    const expected = readFileSync(new URL(`${name}.sha256`, dir), "utf8").trim().split(/\s+/)[0];
    expect(createHash("sha256").update(data).digest("hex")).toBe(expected);
  });

  it("is ignored by git, rebuilt before every web build and still scanned for classes", () => {
    expect(readFileSync(new URL("../.gitignore", import.meta.url), "utf8")).toContain("/public/vendor/scalar-api-reference-*.js");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["build:web"]).toMatch(/^node scripts\/restore-vendor\.mjs && /);
    expect(pkg.scripts["dev:web"]).toMatch(/^node scripts\/restore-vendor\.mjs && /);
    expect(readFileSync(new URL("../src/web/index.css", import.meta.url), "utf8")).toContain(`@source "../../public/vendor/${name}";`);
  });
});
