import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKUPS, DATA_REGION, ENCRYPTION, INCIDENTS, SECURITY_EMAIL, SIGN_IN, SUBPROCESSORS } from "../src/shared/trust";
import { isKnownPage } from "../src/shared/known-routes";
import { metaFor } from "../src/web/components/seo-meta";

const config = readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const envKeys = new Set([...config.matchAll(/^ {2}([A-Z][A-Z0-9_]+): z/gm)].map((m) => m[1]));

/**
 * Settings in config.ts that would send data to a third party. Each one is either a row on the
 * trust page or listed here with the reason it is not, so a new provider can't be added quietly.
 */
const NOT_LISTED: Record<string, string> = {
  GOOGLE_CLIENT_ID: "direct Google sign in is for self host; Multies signs in with Google through Auth0",
  GITHUB_CLIENT_ID: "direct GitHub sign in is for self host; Multies signs in with GitHub through Auth0",
  PUSH_ENABLED: "listed as the optional push notification provider; off in production (not in wrangler.toml [vars])",
  XERO_CLIENT_ID: "Xero invoice reminders are not configured in production",
  STALWART_URL: "the IMAP and SMTP server is a local test server only",
  BODY_STORE_ENDPOINT: "the external body store is not configured in production",
  TURNSTILE_SITE_KEY: "Cloudflare Turnstile is Cloudflare, already listed",
  CF_BEACON_TOKEN: "Cloudflare Web Analytics is Cloudflare, already listed",
  PASSWORD_BREACH_CHECK: "the local password form is off in production; people sign in through Auth0",
};
const PROVIDER_KEYS = ["RESEND_API_KEY", "AUTH0_DOMAIN", "SENTRY_DSN_API", "STRIPE_SECRET_KEY", "LIVEKIT_URL", ...Object.keys(NOT_LISTED)];

describe("trust page facts", () => {
  it("every provider setting in config.ts is on the page or explained", () => {
    const listed = new Set(SUBPROCESSORS.flatMap((s) => s.env));
    for (const k of PROVIDER_KEYS) {
      expect(envKeys.has(k), `${k} exists in config.ts`).toBe(true);
      expect(listed.has(k) || k in NOT_LISTED, `${k} is listed or explained`).toBe(true);
    }
  });

  it("every env var a row names exists in config.ts", () => {
    for (const s of SUBPROCESSORS) for (const k of s.env) expect(envKeys.has(k), `${s.name}: ${k}`).toBe(true);
  });

  it("push stays off in production, so its row stays optional", () => {
    const prodVars = wrangler.split(/^\[vars\]$/m)[1]!.split(/^\[\[|^\[env/m)[0]!;
    expect(prodVars).not.toMatch(/PUSH_ENABLED/);
    expect(prodVars).not.toMatch(/XERO_CLIENT_ID/);
  });

  it("the data region matches the production database", () => {
    expect(wrangler).toMatch(/database_name = "mymail-au"/);
    expect(wrangler).toMatch(/region = "aws:ap-southeast-2"/);
    expect(DATA_REGION[0]!.value).toMatch(/Oceania/);
  });

  it("encryption claims match the code", () => {
    const headers = readFileSync(new URL("../src/server/lib/security-headers.ts", import.meta.url), "utf8");
    expect(headers).toMatch(/max-age=63072000; includeSubDomains/);
    expect(ENCRYPTION.find((f) => f.label === "In transit")!.value).toMatch(/two years/);
    const crypto = readFileSync(new URL("../src/server/lib/crypto.ts", import.meta.url), "utf8");
    expect(crypto).toMatch(/AES-GCM/);
  });

  it("sign in and backup claims match the docs", () => {
    const auth = readFileSync(new URL("../docs/auth.md", import.meta.url), "utf8");
    expect(auth).toMatch(/passkeys on the database connection/);
    expect(SIGN_IN[0]!.value).toMatch(/passkeys/);
    const backup = readFileSync(new URL("../docs/runbooks/db-backup-restore.md", import.meta.url), "utf8");
    expect(backup).toMatch(/7 days on the free plan/);
    expect(BACKUPS[0]!.value).toMatch(/7 days/);
  });

  it("security contact, incidents and route are in place", () => {
    expect(SECURITY_EMAIL).toBe("contact@fintex.au");
    for (const i of INCIDENTS) expect(i.date && i.title && i.impact && i.fix).toBeTruthy();
    expect(isKnownPage("/trust")).toBe(true);
    expect(metaFor("/trust").title).toMatch(/Security/);
    const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
    expect(sitemap).toMatch(/multies\.si\/trust</);
  });

  it("no dashes and no stock phrases in the page copy", async () => {
    const { findIssues } = await import("../scripts/check-copy");
    const text = readFileSync(new URL("../src/shared/trust.ts", import.meta.url), "utf8");
    expect(findIssues("src/shared/trust.ts", text)).toEqual([]);
  });

  it("uses the company's standard legal line and location, word for word", async () => {
    const { LEGAL_ENTITY, LEGAL_LINE_TEXT } = await import("../src/shared/legal");
    expect(LEGAL_LINE_TEXT).toBe("Multies is provided by Fintex Australia Pty Ltd (ABN 60 688 406 108), New South Wales, Australia. Contact: contact@fintex.au.");
    expect(LEGAL_ENTITY.address).toBe("New South Wales, Australia");
    expect(LEGAL_ENTITY.website).toBe("https://fintex.au");
  });

  it("names providers by category and keeps the named list in the DPA (owner approved review, 30 October 2026)", async () => {
    const { LEGAL_DOCS, SUBPROCESSORS: NAMED } = await import("../src/shared/legal");
    const vendors = /Cloudflare|Auth0|Okta|Resend|Stripe|Sentry|LiveKit|Expo\b|Google Public DNS|\bage\b|AWS|PostHog/;
    const trustText = JSON.stringify({ DATA_REGION, SUBPROCESSORS, BACKUPS, SIGN_IN, ENCRYPTION });
    expect(trustText).not.toMatch(vendors);
    for (const slug of ["privacy", "terms", "acceptable-use"] as const) expect(JSON.stringify(LEGAL_DOCS[slug]), slug).not.toMatch(vendors);
    const dpaOutsideTable = JSON.stringify(LEGAL_DOCS.dpa.sections.map((s) => ({ ...s, body: s.body.filter((b) => !(typeof b === "object" && "table" in b && b.table === NAMED)) })));
    expect(dpaOutsideTable).not.toMatch(vendors);
    const names = NAMED.slice(1).map((r) => r[0]);
    for (const n of ["Cloudflare", "Auth0 (Okta)", "Resend", "Stripe", "Sentry", "LiveKit", "Expo", "Google Public DNS", "PostHog"]) expect(names).toContain(n);
    expect(SUBPROCESSORS.length).toBe(NAMED.length - 1);
    const all = JSON.stringify(LEGAL_DOCS);
    expect(all).not.toMatch(/24 hours|99\.9/);
    expect(all).toMatch(/within one business day/);
    expect(BACKUPS.map((b) => b.value).join(" ")).toMatch(/Every copy is encrypted, and copies older than 30 days are deleted/);
  });

  it("shows no internal mailbox or account name in public config or pages", () => {
    const files = ["../wrangler.toml", "../scripts/build-worker.ts", "../src/shared/legal.ts", "../src/shared/trust.ts", "../src/web/pages/trust.tsx", "../src/web/pages/support.tsx", "../src/web/layouts/marketing.tsx", "../src/web/pages/app/mail-apps.tsx", "../src/server/config.ts"];
    for (const f of files) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(text, f).not.toMatch(/mail\.tab\.bot|wildgamingbk|elisoulaj|nepalidokonetwork|MaisySen/i);
    }
  });
});
