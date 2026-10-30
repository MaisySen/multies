import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONNECTIONS, JURISDICTION, LESS_ADMIN, RESIDENCY_ANSWER, residencyMarkdown, residencyStaticHtml, SAFE_TRIAL, STATIC_FACTS_PATHS, WHERE_DATA_LIVES } from "../src/shared/residency";
import { DOCS_MD, LLMS_FULL_TXT, LLMS_TXT } from "../src/server/generated/llms.generated";
import { LEGAL_DOCS } from "../src/shared/legal";
import { SUBPROCESSORS } from "../src/shared/trust";
import { isKnownPage } from "../src/shared/known-routes";

const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const allText = JSON.stringify({ RESIDENCY_ANSWER, WHERE_DATA_LIVES, JURISDICTION, SAFE_TRIAL, LESS_ADMIN, CONNECTIONS });

describe("R60 residency facts", () => {
  it("match the config they describe", () => {
    expect(wrangler).toMatch(/database_name = "mymail-au"/);
    expect(wrangler).toMatch(/region = "aws:ap-southeast-2"/);
    expect(WHERE_DATA_LIVES[0]!.where).toMatch(/Oceania/);
    expect(WHERE_DATA_LIVES[1]!.where).toBe("Sydney");
    // Import uploads sit in KV, which has no region: never claim one.
    expect(wrangler).toMatch(/binding = "IMPORT_FILES"/);
    expect(WHERE_DATA_LIVES.find((r) => /import/i.test(r.data))!.where).toMatch(/Not pinned/);
  });

  it("never claims Australia only storage", () => {
    expect(RESIDENCY_ANSWER).toMatch(/does not offer Australia only storage/);
    expect(allText.replace(/(not offer|not offered)[^.]*Australia only/g, "")).not.toMatch(/Australia only storage (is|are) (available|offered)/i);
    // Anything outside the region is listed, so the claim can be checked by a reader.
    expect(WHERE_DATA_LIVES.filter((r) => r.region === "outside").length).toBeGreaterThanOrEqual(6);
  });

  it("sign in region agrees across trust and privacy", () => {
    expect(SUBPROCESSORS.find((s) => s.name === "Our sign in provider")!.where).toMatch(/^Australia/);
    expect(WHERE_DATA_LIVES.find((r) => /Sign in/.test(r.data))!.where).toBe("Australia");
    const privacy = JSON.stringify(LEGAL_DOCS.privacy);
    expect(privacy).toMatch(/Where your data lives/);
    expect(privacy).toMatch(/does not offer Australia only storage/);
  });

  it("marks planned connections and lists only real ones", () => {
    const planned = CONNECTIONS.filter((c) => c.status === "planned").map((c) => c.name).join(" ");
    expect(planned).toMatch(/WhatsApp/);
    // Not live on production (no secrets set), so not listed as available.
    const available = CONNECTIONS.filter((c) => c.status === "available").map((c) => c.name + c.detail).join(" ");
    expect(available).not.toMatch(/Xero|Google sign in/);
    expect(available).not.toMatch(/WhatsApp/);
  });

  it("keeps the copy rules", () => {
    expect(allText).not.toMatch(/[\u2013\u2014]/);
    expect(allText).not.toMatch(/Cloudflare|Auth0|Resend|Sentry|Stripe|LiveKit/);
  });

  it("reaches readers that do not run scripts", () => {
    for (const p of STATIC_FACTS_PATHS) expect(isKnownPage(p)).toBe(true);
    const html = residencyStaticHtml();
    expect(html).toContain("<h2>Where your data lives</h2>");
    expect(html).toContain("<h2>Try Multies without connecting a client mailbox</h2>");
    for (const r of WHERE_DATA_LIVES) expect(html).toContain(r.where.replace(/&/g, "&amp;"));
    expect(html).not.toMatch(/<script/i);
  });

  it("is in llms.txt, llms-full.txt and /trust.md", () => {
    expect(LLMS_TXT).toContain("## Key facts");
    expect(LLMS_TXT).toContain("https://multies.si/trust.md");
    expect(LLMS_TXT).toContain(RESIDENCY_ANSWER);
    expect(DOCS_MD["/trust.md"]).toBe(residencyMarkdown("https://multies.si"));
    expect(DOCS_MD["/trust.md"]).toContain("| Data | Where | Notes |");
    expect(LLMS_FULL_TXT).toContain("## Jurisdiction and data residency");
  });
});
