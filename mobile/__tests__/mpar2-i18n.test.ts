/** MPAR2: the string layer (English, Nepali, Hindi), language persistence and the phone language. */
import fs from "fs";
import path from "path";
import { bundles, deviceLang, resolveLang, saveLanguageChoice, savedChoice, setLangForTests, tl, tr } from "@/i18n";
import { placeholders } from "@/i18n/core";
import { resetPrefsForTests } from "@/lib/startup-prefs";

const SRC = path.join(__dirname, "..", "src");
/** The screens this round translated, and the shared pieces they draw. */
const TOUCHED = [
  "app/(tabs)/today.tsx", "app/(tabs)/inbox.tsx", "app/(tabs)/chat.tsx", "app/(tabs)/tasks.tsx", "app/(tabs)/more.tsx", "app/(tabs)/_layout.tsx",
  "app/thread/[id].tsx", "app/compose.tsx", "app/chat/[id].tsx", "app/chat/new.tsx", "app/settings.tsx", "app/search.tsx", "app/more/[section].tsx",
  "app/account.tsx", "app/appearance.tsx", "app/language.tsx", "app/billing.tsx", "app/get-started.tsx",
  "components/chat.tsx", "components/m1-more.tsx", "components/m1-work.tsx", "components/message-row.tsx", "components/m3-ui.tsx", "components/ui.tsx",
  "lib/today.ts", "lib/tasks.ts", "lib/social.ts", "lib/mail-rules.ts", "components/gesture-settings.tsx", "components/swipe-row.tsx", "components/meetings.tsx", "components/notification-bell.tsx", "components/task-query-box.tsx", "lib/meetings.ts", "lib/triage.ts", "lib/chat.ts", "lib/global-search.ts", "lib/mpar2.ts",
];
/** Words that read the same in every language (an example address). */
const SAME = new Set(["m.compose.name_example_com_au"]);

function keysUsed(): Set<string> {
  const out = new Set<string>();
  for (const f of TOUCHED) for (const m of fs.readFileSync(path.join(SRC, f), "utf8").matchAll(/\btr\(\s*"([^"]+)"/g)) out.add(m[1]);
  for (const id of ["mail", "invite", "task", "site", "palette", "tour", "open_mail", "doc"]) { out.add(`m.started.${id}_title`); out.add(`m.started.${id}_body`); }
  return out;
}

afterEach(() => { setLangForTests("en"); resetPrefsForTests(); });

describe("bundles", () => {
  it("has every key the touched screens use in English, Nepali and Hindi", () => {
    const used = keysUsed();
    expect(used.size).toBeGreaterThan(300);
    for (const k of used) {
      expect([k, bundles.en[k] !== undefined]).toEqual([k, true]);
      if (SAME.has(k)) continue;
      expect([k, bundles.ne[k] !== undefined]).toEqual([k, true]);
      expect([k, bundles.hi[k] !== undefined]).toEqual([k, true]);
    }
  });
  it("has a Nepali and Hindi line for every app key, with the same placeholders", () => {
    for (const [k, v] of Object.entries(bundles.en)) {
      if (!k.startsWith("m.") || SAME.has(k)) continue;
      for (const l of ["ne", "hi"] as const) {
        expect([l, k, bundles[l][k] !== undefined]).toEqual([l, k, true]);
        expect([l, k, placeholders(bundles[l][k])]).toEqual([l, k, placeholders(v)]);
      }
    }
  });
  it("Nepali and Hindi lines are written in Devanagari, not left in English", () => {
    const latinOnly = (s: string) => !/[\u0900-\u097F]/.test(s.replace(/\{\w+\}/g, ""));
    for (const l of ["ne", "hi"] as const) {
      const english = Object.entries(bundles[l]).filter(([k, v]) => k.startsWith("m.") && typeof v === "string" && latinOnly(v) && !SAME.has(k));
      // Only brand and code words stay Latin (Cc, Re:, Fwd:).
      expect(english.map(([k]) => k).sort()).toEqual(["m.compose.cc", "m.compose.fwd_subj", "m.compose.re_subj", "m.thread.cc_names"]);
    }
  });
  it("copy has no dashes and no other product names", () => {
    for (const l of ["en", "ne", "hi"] as const) for (const [k, v] of Object.entries(bundles[l])) {
      if (!k.startsWith("m.")) continue;
      const s = typeof v === "string" ? v : Object.values(v).join(" ");
      expect([k, /[\u2013\u2014]| - /.test(s)]).toEqual([k, false]);
    }
  });
});

describe("tr and tl", () => {
  it("reads the language on screen, with plurals and numbers", () => {
    expect(tr("nav.inbox")).toBe("Inbox");
    setLangForTests("ne");
    expect(tr("nav.inbox")).toBe("इनबक्स");
    expect(tr("m.started.n_of_total_done", { done: 2, total: 5 })).toBe("५ मध्ये २ सकियो");
    setLangForTests("hi");
    expect(tr("m.more.sections_hidden_tap_to_edit", { count: 1 })).toContain("छिपा है");
  });
  it("falls back to English, and never shows a raw key", () => {
    setLangForTests("ne");
    expect(tr("m.nobody.wrote_this_key")).toBe("Wrote this key");
    expect(tr("m.compose.name_example_com_au")).toBe("name@example.com.au");
    for (const k of keysUsed()) expect(tr(k)).not.toMatch(/^m\./);
  });
  it("translates menu labels from data by their English words", () => {
    expect(tl("nav", "Plan and billing")).toBe("Plan and billing");
    setLangForTests("hi");
    expect(tl("nav", "Plan and billing")).toBe(bundles.hi["nav.plan_and_billing"]);
    expect(tl("nav", "Something new")).toBe("Something new");
  });
});

describe("language choice", () => {
  it("follows the phone until a language is picked, and keeps the pick", () => {
    expect(savedChoice()).toBe("system");
    expect(resolveLang("system", () => "ne")).toBe("ne");
    expect(saveLanguageChoice("hi")).toBe("hi");
    expect(savedChoice()).toBe("hi");
    expect(resolveLang(savedChoice(), () => "ne")).toBe("hi");
    saveLanguageChoice("system");
    expect(savedChoice()).toBe("system");
  });
  it("reads the phone language and fails soft to English", () => {
    const L = require("expo-localization");
    const spy = jest.spyOn(L, "getLocales");
    spy.mockReturnValue([{ languageTag: "ne-NP", languageCode: "ne" }]);
    expect(deviceLang()).toBe("ne");
    spy.mockReturnValue([{ languageTag: "hi-IN", languageCode: "hi" }]);
    expect(deviceLang()).toBe("hi");
    spy.mockReturnValue([{ languageTag: "fr-FR", languageCode: "fr" }]);
    expect(deviceLang()).toBe("en");
    spy.mockImplementation(() => { throw new Error("no module"); });
    expect(deviceLang()).toBe("en");
    spy.mockRestore();
  });
});
