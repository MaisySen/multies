/** MPAR2: Appearance (match phone, light, dark) and the Forest accent. */
import { paletteFor, resolveScheme, saveAppearance, savedAccent, savedMode, palettes, lh } from "@/theme";
import { resetPrefsForTests } from "@/lib/startup-prefs";

const lum = (hex: string) => {
  const c = hex.replace("#", "").match(/../g)!.map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

afterEach(() => resetPrefsForTests());

it("Forest uses the web's greens and keeps everything else", () => {
  expect(paletteFor("light", "forest").brand).toBe("#1F6F43");
  expect(paletteFor("dark", "forest").brand).toBe("#4CC38A");
  expect(paletteFor("light", "forest").bg).toBe(palettes.light.bg);
  expect(paletteFor("dark", "forest").surface).toBe(palettes.dark.surface);
  expect(paletteFor("light", "blue")).toBe(palettes.light);
});
it("Forest text and buttons pass contrast in light and dark", () => {
  for (const s of ["light", "dark"] as const) {
    const p = paletteFor(s, "forest");
    expect(contrast(p.brandFg, p.brandFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.brand, p.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.brand, p.bg)).toBeGreaterThanOrEqual(4.5);
  }
});
it("match phone follows the phone; light and dark are fixed", () => {
  expect(resolveScheme("system", "light")).toBe("light");
  expect(resolveScheme("system", "dark")).toBe("dark");
  expect(resolveScheme("system", null)).toBe("dark");
  expect(resolveScheme("light", "dark")).toBe("light");
  expect(resolveScheme("dark", "light")).toBe("dark");
});
it("keeps the choice for the next start", () => {
  expect([savedMode(), savedAccent()]).toEqual(["system", "blue"]);
  saveAppearance("light", "forest");
  expect([savedMode(), savedAccent()]).toEqual(["light", "forest"]);
  saveAppearance("system", "blue");
  expect([savedMode(), savedAccent()]).toEqual(["system", "blue"]);
});
it("line heights stay as given in English", () => { expect(lh(22)).toBe(22); });
