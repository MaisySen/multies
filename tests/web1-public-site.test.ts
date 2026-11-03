/**
 * WEB1: the public site carries no stale detail. One public support address, a Get the app block that never shows a
 * dead store link, a public beta slot that stays hidden until switched on, a privacy policy that covers the phone
 * apps, AI, connected networks and review accounts, What's new up to date, and a sitemap that matches the pages.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET_THE_APP, getTheAppView, safeStoreUrl } from "../src/shared/get-the-app";
import { aiCostAnswer, aiPrivacyBlocks, BUILT_IN_AI_LIVE, TEAM_AI_LIVE } from "../src/shared/ai-public-copy";
import { LEGAL_DOCS, LEGAL_ENTITY } from "../src/shared/legal";
import { WHATS_NEW } from "../src/shared/whats-new";
import { publicWhatsNew } from "../src/shared/whats-new-public";
import { canonicalUrl, SITE_URL } from "../src/web/components/seo-meta";
import { isKnownPage } from "../src/shared/known-routes";

const sitemap = readFileSync("public/sitemap.xml", "utf8");
const sitemapPaths = [...sitemap.matchAll(/<loc>https:\/\/multies\.si([^<]*)<\/loc>/g)].map((m) => m[1] || "/");

describe("WEB1 Get the app and the public beta slot", () => {
  it("shows no store link while the listings are not live, and keeps the beta hidden", () => {
    expect(GET_THE_APP.appStoreUrl).toBeNull();
    expect(GET_THE_APP.googlePlayUrl).toBeNull();
    expect(GET_THE_APP.publicBeta.visible).toBe(false);
    expect(GET_THE_APP.publicBeta.url).toMatch(/^https:\/\/testflight\.apple\.com\/join\/[A-Za-z0-9]+$/);
    const v = getTheAppView();
    expect(v).toMatchObject({ appStore: null, googlePlay: null, beta: null, onStores: false });
  });

  it("shows the beta link once switched on, and store links once set", () => {
    const on = getTheAppView({ ...GET_THE_APP, publicBeta: { ...GET_THE_APP.publicBeta, visible: true } });
    expect(on.beta).toBe(GET_THE_APP.publicBeta.url);
    const stores = getTheAppView({ ...GET_THE_APP, appStoreUrl: "https://apps.apple.com/app/id1", googlePlayUrl: "https://play.google.com/store/apps/details?id=x" });
    expect(stores.onStores).toBe(true);
    expect(stores.beta).toBeNull();
  });

  it("refuses any link that is not https to the two stores or TestFlight", () => {
    for (const bad of ["http://apps.apple.com/app/id1", "https://evil.example/app", "javascript:alert(1)", "https://apps.apple.com.evil.example/x", ""]) {
      expect(safeStoreUrl(bad), bad).toBeNull();
    }
  });
});

describe("WEB1 one public support address", () => {
  it("public pages use the company address, not a second one", () => {
    for (const f of ["src/web/pages/support.tsx", "src/web/pages/contact.tsx", "src/server/routes/contact.ts", "src/server/services/mail/send-guard-r34.ts"]) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/support@multies\.si/);
    }
    expect(LEGAL_ENTITY.supportEmail).toBe(LEGAL_ENTITY.contactEmail);
    expect(LEGAL_ENTITY.privacyEmail).toBe(LEGAL_ENTITY.contactEmail);
  });
});

describe("WEB1 privacy policy covers what is live", () => {
  const privacy = JSON.stringify(LEGAL_DOCS.privacy);
  const ids = LEGAL_DOCS.privacy.sections.map((s) => s.id);
  it("has the phone apps, AI, connected networks and review accounts", () => {
    for (const id of ["phone-apps", "ai", "networks", "demo", "where", "keep", "rights", "changes"]) expect(ids, id).toContain(id);
    expect(privacy).toMatch(/Delete my account/);
    expect(privacy).toMatch(/never receive any biometric data/);
    expect(privacy).toMatch(/Meta for Facebook, Instagram, Messenger and WhatsApp/);
    expect(privacy).toMatch(/not use your content to train AI models/);
    expect(privacy).toMatch(/app store reviewers/);
    expect(privacy).toMatch(/never hold real customer data/);
    expect(privacy).toContain(LEGAL_ENTITY.privacyEmail);
  });
  it("names no built in AI or Team AI until those rounds are live", () => {
    if (!BUILT_IN_AI_LIVE) {
      expect(privacy).not.toMatch(/Built in AI/);
      expect(aiCostAnswer()).toMatch(/Bring your own AI/);
    }
    if (!TEAM_AI_LIVE) expect(privacy).not.toMatch(/Team AI/);
    if (BUILT_IN_AI_LIVE) expect(privacy).toMatch(/Built in AI runs on our infrastructure/);
    if (TEAM_AI_LIVE) {
      expect(privacy).toMatch(/Team AI keeps the memory/);
      expect(aiCostAnswer()).toMatch(/Team AI gets 50 free runs a day per workspace/);
    }
    expect(aiCostAnswer(true, false)).not.toMatch(/Team AI/);
    expect(aiPrivacyBlocks(true).join(" ")).toMatch(/never bills/);
    expect(aiCostAnswer(true)).toMatch(/never bills you/);
  });
  it("keeps every public copy rule: no dashes, no other product names", () => {
    const copy = [privacy, aiCostAnswer(true), aiPrivacyBlocks(true, true).join(" "), JSON.stringify(WHATS_NEW.slice(0, 2))].join(" ");
    expect(copy).not.toMatch(/[\u2013\u2014]| - /);
    expect(copy).not.toMatch(/tab\.bot|ClickUp|Notion|Asana|Monday|Trello/i);
  });
});

describe("WEB1 What's new and the sitemap", () => {
  it("lists Forms upgrade and Ask v2, keeps the in app list at 14, and loses no earlier entry", () => {
    expect(WHATS_NEW.length).toBeLessThanOrEqual(14);
    const ids = publicWhatsNew().map((e) => e.id);
    for (const id of ["2026-11-02-forms-upgrade", "2026-11-02-ask-v2", "2026-11-01-faster-search", "2026-10-28-whats-new", "2026-11-01-clear-errors", "2026-11-01-forms-plus"]) expect(ids, id).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("points /changelog at /whats-new and every other page at itself", () => {
    expect(canonicalUrl("/changelog")).toBe(`${SITE_URL}/whats-new`);
    expect(canonicalUrl("/whats-new")).toBe(`${SITE_URL}/whats-new`);
    expect(canonicalUrl("/privacy/")).toBe(`${SITE_URL}/privacy`);
    expect(canonicalUrl("/")).toBe(`${SITE_URL}/`);
  });
  it("sitemap lists each public page once, all known, without the duplicate", () => {
    expect(new Set(sitemapPaths).size).toBe(sitemapPaths.length);
    for (const p of sitemapPaths) expect(isKnownPage(p), p).toBe(true);
    expect(sitemapPaths).not.toContain("/changelog");
    for (const p of ["/", "/privacy", "/support", "/whats-new", "/delete-account", "/contact", "/pricing"]) expect(sitemapPaths).toContain(p);
  });
});
