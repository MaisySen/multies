import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { formatMessage, placeholders, slugKey, translate, uiLangOf, wordsFromKey, type Bundle } from "@/web/i18n/core";
import { en } from "@/web/i18n/en";
import { ne } from "@/web/i18n/ne";
import { hi } from "@/web/i18n/hi";
import { enableI18n, missingKeys, setLanguage, t, tl, uiLocale, currentLang } from "@/web/i18n";
import { pickLanguage } from "@/web/i18n/boot";
import { localeForPick } from "@/web/components/language-r104";
import { num, timeAgo } from "@/web/lib/format";
import { formatCount } from "@/web/lib/format-count";
import { emptyTasksCopy } from "@/web/lib/empty-states";
import { WHATS_NEW } from "@/shared/whats-new";

/** R104 (LANG_R104): the message format, the bundles, the runtime switch, Intl per language and admin suggestions. */

describe("message format", () => {
  it("fills placeholders and keeps unknown ones as written", () => {
    expect(formatMessage("Hi {name}, {n} new", { name: "Sita", n: 3 }, "en")).toBe("Hi Sita, 3 new");
    expect(formatMessage("Hi {name}", {}, "en")).toBe("Hi {name}");
    expect(formatMessage("Plain", undefined, "en")).toBe("Plain");
  });
  it("picks plural forms per language", () => {
    const m = { one: "{count} message", other: "{count} messages", zero: "No messages" };
    expect(formatMessage(m, { count: 0 }, "en")).toBe("No messages");
    expect(formatMessage(m, { count: 1 }, "en")).toBe("1 message");
    expect(formatMessage(m, { count: 2 }, "en")).toBe("2 messages");
    expect(formatMessage({ one: "{count} सन्देश", other: "{count} सन्देशहरू" }, { count: 1 }, "ne")).toBe("१ सन्देश");
    expect(formatMessage({ one: "{count} संदेश", other: "{count} संदेश" }, { count: 1500 }, "hi")).toBe("1,500 संदेश");
  });
  it("falls back to English, then to the caller's default, then to words, never a raw key", () => {
    const bundles: Partial<Record<"en" | "ne" | "hi", Bundle>> = { en: { "a.b": "English" }, ne: { "a.c": "नेपाली" } };
    expect(translate("a.c", undefined, "ne", bundles)).toEqual({ text: "नेपाली", lang: "ne", missing: false });
    expect(translate("a.b", undefined, "ne", bundles)).toEqual({ text: "English", lang: "en", missing: false });
    expect(translate("a.zz", undefined, "hi", bundles, "Given")).toMatchObject({ text: "Given", missing: true });
    expect(translate("inbox.empty_title", undefined, "hi", bundles)).toMatchObject({ text: "Empty title", missing: true });
    expect(wordsFromKey("x.someThing_here")).toBe("Some thing here");
  });
  it("reads app languages from saved and browser locales", () => {
    expect(uiLangOf("hi-IN")).toBe("hi");
    expect(uiLangOf("ne")).toBe("ne");
    expect(uiLangOf("en-AU")).toBe("en");
    expect(uiLangOf("fr")).toBe("en");
    expect(uiLangOf(null)).toBe("en");
    expect(slugKey("Plan and billing")).toBe("plan_and_billing");
  });
});

describe("bundles", () => {
  const dash = /[\u2013\u2014]| - /;
  it("English has every key the code asks for (the missing key check)", () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    walk("src/web");
    const asked = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(/\b(?:tr|t)\("([a-z0-9_]+\.[a-z0-9_.]+)"/g)) asked.add(m[1]);
    expect(asked.size).toBeGreaterThan(300);
    expect([...asked].filter((k) => !(k in en))).toEqual([]);
  });
  for (const [name, b] of [["ne", ne], ["hi", hi]] as const) {
    it(`${name} only has English keys, keeps every placeholder and the brand, and uses no dashes`, () => {
      for (const [k, v] of Object.entries(b)) {
        expect(k in en, k).toBe(true);
        expect(placeholders(v), k).toEqual(placeholders(en[k]));
        const s = typeof v === "string" ? v : Object.values(v).join(" ");
        expect(dash.test(s), `${k}: ${s}`).toBe(false);
        const e = typeof en[k] === "string" ? en[k] as string : "";
        if (e.includes("Multies")) expect(s.includes("Multies"), k).toBe(true);
        expect(s.trim().length, k).toBeGreaterThan(0);
      }
    });
    it(`${name} translates the first wave (at least 90 percent of the English keys)`, () => {
      expect(Object.keys(b).length / Object.keys(en).length).toBeGreaterThan(0.9);
    });
  }
  it("English copy has no dashes either", () => {
    for (const [k, v] of Object.entries(en)) expect(dash.test(typeof v === "string" ? v : v.other), k).toBe(false);
  });
});

describe("runtime switch", () => {
  afterEach(async () => { await setLanguage("en"); enableI18n(false); });
  it("off is English exactly: no language loads and formats stay en-AU", async () => {
    enableI18n(false);
    expect(await setLanguage("ne")).toBe("en");
    expect(t("common.cancel")).toBe("Cancel");
    expect(tl("nav", "Inbox")).toBe("Inbox");
    expect(uiLocale()).toBeNull();
    expect(num(1500)).toBe((1500).toLocaleString("en-AU"));
    expect(timeAgo(new Date(Date.now() - 120_000))).toBe("2m ago");
    expect(emptyTasksCopy("list", false).title).toBe("No tasks yet");
  });
  it("on, Nepali and Hindi load lazily and change text, digits and relative times without a reload", async () => {
    enableI18n(true);
    expect(await setLanguage("ne")).toBe("ne");
    expect(currentLang()).toBe("ne");
    expect(t("common.cancel")).toBe(ne["common.cancel"]);
    expect(tl("nav", "Inbox")).toBe(ne["nav.inbox"]);
    expect(uiLocale()).toBe("ne-NP");
    expect(num(1500)).toBe("१,५००");
    expect(formatCount(1500)).toBe("१,५००");
    expect(timeAgo(new Date(Date.now() - 120_000))).toMatch(/[०-९]/);
    expect(emptyTasksCopy("list", false).title).not.toBe("No tasks yet");
    expect(await setLanguage("hi")).toBe("hi");
    expect(t("common.cancel")).toBe(hi["common.cancel"]);
    expect(num(150000)).toBe("1,50,000");
    expect(t("no.such_key_here", undefined, "Fallback words")).toBe("Fallback words");
    expect(t("no.such_key_there")).toBe("Such key there");
    expect(missingKeys()).toContain("no.such_key_there");
    expect(missingKeys()).not.toContain("no.such_key_here");
  });
  it("picks the saved language first, then this browser's pick, then English in the app or the browser's language outside it", () => {
    expect(pickLanguage({ saved: "hi-IN", stored: "ne", browser: "ne", inApp: true })).toBe("hi");
    expect(pickLanguage({ saved: "en-GB", stored: "ne", browser: "ne", inApp: true })).toBe("en");
    expect(pickLanguage({ saved: null, stored: "ne", browser: "hi", inApp: true })).toBe("ne");
    expect(pickLanguage({ saved: null, stored: null, browser: "hi", inApp: true })).toBe("en");
    expect(pickLanguage({ saved: undefined, stored: null, browser: "hi", inApp: false })).toBe("hi");
  });
  it("saves the picked language without losing an English variant the person had", () => {
    expect(localeForPick("ne", "en-GB")).toBe("ne");
    expect(localeForPick("en", "en-GB")).toBe("en-GB");
    expect(localeForPick("en", "hi")).toBe("en");
    expect(localeForPick("en", null)).toBe("en");
  });
  it("What's new has the languages entry, in all three languages, and keeps 14", () => {
    expect(WHATS_NEW.length).toBe(14);
    expect(WHATS_NEW[0].id).toBe("2026-11-03-nepali-hindi");
    for (const b of [ne, hi]) {
      expect(b[`whatsnew.${WHATS_NEW[0].id}.title`]).toBeTruthy();
      expect(b[`whatsnew.${WHATS_NEW[0].id}.body`]).toBeTruthy();
    }
  });
});

describe("wording suggestions (admins)", () => {
  let ctx: Awaited<ReturnType<typeof makeTestApp>>;
  let owner: Client;
  beforeEach(async () => {
    ctx = await makeTestApp({ FEATURES: "LANG_R104" });
    owner = new Client(ctx.app);
    await owner.signup("owner@acme.io", "Olive Owner");
  });
  it("is not there while LANG_R104 is off, and config says off", async () => {
    const off = await makeTestApp();
    const c = new Client(off.app);
    await c.signup("solo@acme.io", "Solo");
    expect((await c.get("/api/config")).body.langR104).toBe(false);
    expect((await c.get("/api/i18n/suggestions")).status).toBe(404);
    expect((await c.post("/api/i18n/suggestions", { key: "common.cancel", lang: "ne", suggestion: "x" })).status).toBe(404);
  });
  it("keeps a suggestion for review and lists it; nothing applies by itself", async () => {
    expect((await owner.get("/api/config")).body.langR104).toBe(true);
    expect((await owner.get("/api/i18n/suggestions")).body.suggestions).toEqual([]);
    const r = await owner.post("/api/i18n/suggestions", { key: "common.cancel", lang: "ne", suggestion: "छोड्नुहोस्", current: "रद्द गर्नुहोस्", english: "Cancel" });
    expect(r.status).toBe(201);
    const list = (await owner.get("/api/i18n/suggestions")).body.suggestions;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "common.cancel", lang: "ne", suggestion: "छोड्नुहोस्", current: "रद्द गर्नुहोस्", english: "Cancel", by: "owner@acme.io" });
  });
  it("checks the input", async () => {
    expect((await owner.post("/api/i18n/suggestions", { key: "Bad Key!", lang: "ne", suggestion: "x" })).status).toBe(422);
    expect((await owner.post("/api/i18n/suggestions", { key: "common.cancel", lang: "fr", suggestion: "x" })).status).toBe(422);
    expect((await owner.post("/api/i18n/suggestions", { key: "common.cancel", lang: "hi", suggestion: "   " })).status).toBe(422);
    expect((await owner.post("/api/i18n/suggestions", { key: "common.cancel", lang: "hi", suggestion: "x".repeat(501) })).status).toBe(422);
  });
  it("is for workspace admins only, and needs sign in", async () => {
    const invite = await owner.post("/api/team/invites", { email: "mate@example.com", role: "member" });
    const mate = new Client(ctx.app);
    await mate.signup("mate@example.com", "Teammate", "");
    expect((await mate.post(`/api/invites/${invite.body.link.split("/invite/")[1]}/accept`)).status).toBe(200);
    expect((await mate.get("/api/i18n/suggestions")).status).toBe(403);
    expect((await mate.post("/api/i18n/suggestions", { key: "common.cancel", lang: "ne", suggestion: "x" })).status).toBe(403);
    expect((await new Client(ctx.app).get("/api/i18n/suggestions")).status).toBe(401);
  });
});

describe("Nepali without the browser's Nepali data", () => {
  it("still writes Nepali digits, lakh grouping and Nepali month and weekday names", async () => {
    const { formatDateIn, numberLocale, devaDigits } = await import("../src/web/i18n/intl");
    expect((150000).toLocaleString(numberLocale("ne-NP", false))).toBe("१,५०,०००");
    expect(numberLocale("ne-NP", true)).toBe("ne-NP");
    expect(numberLocale("hi-IN", false)).toBe("hi-IN");
    const d = new Date(Date.UTC(2026, 10, 3, 9, 5));
    expect(formatDateIn(d, "ne-NP", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }, false)).toBe("३ नोभेम्बर २०२६");
    expect(formatDateIn(d, "ne-NP", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }, false)).toBe("मङ्गलबार ३ नोभेम्बर");
    expect(formatDateIn(d, "ne-NP", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }, false)).toBe("९:०५");
    expect(formatDateIn(d, "en-AU", { day: "numeric", month: "short", timeZone: "UTC" }, false)).toBe("3 Nov");
    expect(devaDigits("2026")).toBe("२०२६");
  });
});
