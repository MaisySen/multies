import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dropCdnFallback, fontsDir } from "../scripts/board-fonts";

describe("R89 board fonts come from our own origin", () => {
  const dir = path.join(process.cwd(), "node_modules", "@excalidraw", "excalidraw", "dist", "prod");
  const file = readdirSync(dir).map((f) => path.join(dir, f)).find((f) => f.endsWith(".js") && readFileSync(f, "utf8").includes("ASSETS_FALLBACK_URL"));

  it("finds and removes the library's CDN fallback in the installed version", () => {
    expect(file).toBeTruthy();
    const code = readFileSync(file!, "utf8");
    const out = dropCdnFallback(code);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/push\(new URL\(\w+,\w+\.ASSETS_FALLBACK_URL\)\)/);
    expect(out!.length).toBeLessThan(code.length);
  });

  it("returns null when the library code is not what it expects, so the build fails loudly", () => {
    expect(dropCdnFallback("const x = 1;")).toBeNull();
  });

  it("ships every font family, the CJK one included", () => {
    expect(readdirSync(fontsDir(process.cwd()))).toEqual(expect.arrayContaining(["Excalifont", "Virgil", "Xiaolai"]));
  });
});
