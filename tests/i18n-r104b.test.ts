/**
 * R104B (LANG_R104): the second wave of Nepali and Hindi (Docs, Chat, Calendar settings, Compose, Contacts and CRM,
 * Meetings and calls, Drive and Files, the social composer, Home widgets, Appearance, AI settings, Get started and tours).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, it, expect, afterEach } from "vitest";
import { placeholders } from "@/web/i18n/core";
import { en } from "@/web/i18n/en";
import { ne as ne2 } from "@/web/i18n/w2/ne";
import { hi as hi2 } from "@/web/i18n/w2/hi";
import { W2_EN } from "@/web/i18n/w2/all-en";
import { enableI18n, setLanguage, t } from "@/web/i18n";

const english: Record<string, unknown> = { ...en, ...W2_EN };
const text = (v: unknown) => (typeof v === "string" ? v : Object.values(v as Record<string, string>).join(" "));

describe("second wave bundles", () => {
  it("every key the pages ask for has English, and the second wave English is all new keys", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    walk("src/web");
    const asked = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\b(?:tr|trB|t)\("([a-z0-9_]+\.[a-z0-9_.]+)"/g)) asked.add(m[1]);
    expect([...asked].filter((k) => !(k in english))).toEqual([]);
    expect(Object.keys(W2_EN).filter((k) => k in en)).toEqual([]);
    expect(Object.keys(W2_EN).length).toBeGreaterThan(1500);
  });
  for (const [name, b] of [["ne", ne2], ["hi", hi2]] as const) {
    it(`${name} covers every second wave key, keeps placeholders and the brand, and uses no dashes`, () => {
      const missing = Object.keys(W2_EN).filter((k) => !(k in b));
      expect(missing).toEqual([]);
      for (const [k, v] of Object.entries(b)) {
        expect(k in english, k).toBe(true);
        expect(placeholders(v), k).toEqual(placeholders(english[k] as string));
        const s = text(v);
        expect(/[\u2013\u2014]| - /.test(s), `${k}: ${s}`).toBe(false);
        if (text(english[k]).includes("Multies")) expect(s.includes("Multies"), k).toBe(true);
        expect(s.trim().length, k).toBeGreaterThan(0);
      }
    });
  }
  it("second wave English has no long dashes", () => {
    for (const [k, v] of Object.entries(W2_EN)) expect(/[\u2013\u2014]/.test(text(v)), k).toBe(false);
  });
  it("each language chunk stays small and the English rides in page chunks, not the app's entry", () => {
    for (const f of ["src/web/i18n/w2/ne.ts", "src/web/i18n/w2/hi.ts"]) expect(gzipSync(readFileSync(f)).length).toBeLessThan(60_000);
    const index = readFileSync("src/web/i18n/index.ts", "utf8");
    expect(index).not.toMatch(/from "\.\/w2\/en-/);
    expect(index).toMatch(/import\("\.\/w2\/ne"\)/);
    expect(readFileSync("src/web/main.tsx", "utf8")).not.toMatch(/i18n\/w2/);
  });
  it("every built in checklist and tour text has a translation key", () => {
    const words = new Set(Object.entries(W2_EN).filter(([k]) => k.startsWith("home.builtin_")).map(([, v]) => v as string));
    const src = readFileSync("src/shared/tours-r130.ts", "utf8");
    const builtIn = [...src.matchAll(/(?:title|body): "((?:[^"\\]|\\.)+)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(builtIn.length).toBeGreaterThan(40);
    for (const w of builtIn) expect(words.has(w), w).toBe(true);
  });
});

describe("second wave at run time", () => {
  afterEach(async () => { await setLanguage("en"); enableI18n(false); });
  it("off is English exactly; on, Nepali and Hindi load with the second wave", async () => {
    enableI18n(false);
    expect(await setLanguage("ne")).toBe("en");
    expect(t("chat.new_channel")).toBe("New channel");
    expect(t("meetings.start_recording")).toBe("Start recording");
    enableI18n(true);
    expect(await setLanguage("ne")).toBe("ne");
    expect(t("chat.new_channel")).toBe(ne2["chat.new_channel"]);
    expect(t("calendar.revoke_name", { name: "iPhone" })).toBe("iPhone रद्द गर्नुहोस्");
    expect(t("common.cancel")).not.toBe("Cancel");
    expect(await setLanguage("hi")).toBe("hi");
    expect(t("files.upload_new_version")).toBe(hi2["files.upload_new_version"]);
    expect(t("docs.dismiss")).toBe(hi2["docs.dismiss"]);
  });
});
