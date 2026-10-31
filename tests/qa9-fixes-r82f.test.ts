import { describe, it, expect } from "vitest";

/** R82F: the QA9 fix round (MB-274 to MB-286): pure parts that the e2e specs lean on. */
const nav = await import("@/web/layouts/shell-nav");
const { paletteScore } = await import("@/web/lib/palette-registry");
const { parseHex } = await import("@/shared/branding");
const { tidyDescription, topEntries, DESCRIPTIONS } = await import("../scripts/build-connections-catalog");
const catalog = (await import("@/shared/connections-catalog.json")).default as { apps: { slug: string; description: string; availability: "ready" | "key" | "soon" }[] };
const top = (await import("@/shared/connections-catalog-top.json")).default as { total: number; apps: { slug: string }[] };

describe("MB-283 page titles", () => {
  it("names the page, then Multies", () => {
    expect(nav.pageTitle("/app/tasks")).toBe("Tasks · Multies");
    expect(nav.pageTitle("/app/mail")).toBe("Mail · Multies");
    expect(nav.pageTitle("/app/my-work")).toBe("My Work · Multies");
    expect(nav.pageTitle("/app/goals")).toBe("Goals · Multies");
    expect(nav.pageTitle("/app/docs/doc_123")).toBe("Docs · Multies");
  });
  it("settings and connection tabs name their parent", () => {
    expect(nav.pageTitle("/app/settings/branding")).toBe("Branding · Settings · Multies");
    expect(nav.pageTitle("/app/settings")).toBe("Settings · Multies");
    expect(nav.pageTitle("/app/settings/apps")).toBe("Connections · Multies");
    expect(nav.pageTitle("/app/settings/apps/mail")).toBe("Mail accounts · Connections · Multies");
    expect(nav.pageTitle("/app/settings/apps/webhooks")).toBe("Webhooks · Connections · Multies");
  });
  it("tools pages and pages with no sidebar entry still get a real name", () => {
    expect(nav.pageTitle("/app/tools/convert")).toBe("Convert files · Multies");
    expect(nav.pageTitle("/app/tools/sign")).toBe("E-sign · Multies");
    expect(nav.pageTitle("/app/deals")).toBe("Deals · Multies");
    for (const p of ["/app", "/app/triage", "/app/inbox", "/app/meetings/m1", "/app/admin/reports", "/app/time", "/app/scheduling", "/app/files"]) {
      expect(nav.pageTitle(p)).not.toBe("Multies");
    }
  });
});

describe("MB-279 one home for outside apps", () => {
  it("the Workspace sidebar has one Connections entry and no Integrations", () => {
    const ws = nav.SECTIONS.find((s) => s.id === "workspace")!;
    expect(ws.pages.filter((p) => p.label === "Connections")).toHaveLength(1);
    expect(nav.SECTIONS.flatMap((s) => s.pages).some((p) => p.to === "/app/integrations" || p.label === "Integrations")).toBe(false);
  });
  it("breadcrumbs name each Connections tab", () => {
    expect(nav.breadcrumbs("/app/settings/apps/mail", "").map((c) => c.label)).toEqual(["Settings", "Connections", "Mail accounts"]);
    // P1 layout: Social posts left Connections for Social.
    expect(nav.breadcrumbs("/app/social/posts", "").map((c) => c.label)).toEqual(["Social", "Posts"]);
  });
});

describe("MB-275 Ctrl K", () => {
  it("split finds Split PDF by name", () => {
    expect(paletteScore("Split PDF|tools-split", "split")).toBe(1);
  });
  it("a Nepali query filters instead of matching everything", () => {
    for (const label of ["Tasks", "Mail", "Settings", "Convert files", "Split PDF", "Write an email"]) {
      expect(paletteScore(`${label}|x`, "कार्य")).toBe(0);
      expect(paletteScore(`${label}|x`, "इमेल पठाउनुहोस्")).toBe(0);
    }
    // A Nepali keyword on an item still finds it.
    expect(paletteScore("Tasks|x", "कार्य", ["कार्य"])).toBeGreaterThan(0);
  });
  it("punctuation alone matches nothing", () => {
    expect(paletteScore("Tasks|x", "!!!!")).toBe(0);
  });
});

describe("MB-285 hex colours", () => {
  it("reads common spellings and refuses the rest", () => {
    expect(parseHex("#0066CC")).toBe("#0066cc");
    expect(parseHex("0066cc")).toBe("#0066cc");
    expect(parseHex("#06c")).toBe("#0066cc");
    expect(parseHex("zz12")).toBeNull();
    expect(parseHex("#12345")).toBeNull();
    expect(parseHex("")).toBeNull();
  });
});

describe("MB-284 and MB-280 connections catalog", () => {
  it("descriptions read as whole sentences with no doubled words or long dashes", () => {
    expect(tidyDescription("Twitter, Inc. was a company which was named for named for its bird.")).not.toMatch(/named for named for/);
    expect(tidyDescription("Short form video + creation tools")).toBe("Short form video, creation tools");
    const x = catalog.apps.find((a) => a.slug === "twitter")!;
    expect(x.description).toBe(DESCRIPTIONS.twitter);
    for (const a of catalog.apps) {
      expect(a.description).not.toMatch(/[\u2013\u2014]| - /);
      expect(a.description).not.toMatch(/\b(\w+ \w+) \1\b/i);
    }
  });
  it("the first screen list is the start of the full list, social networks first", () => {
    expect(top.total).toBe(catalog.apps.length);
    expect(top.apps[0].slug).toBe("facebook");
    expect(top.apps.length).toBeGreaterThanOrEqual(48);
    expect(topEntries(catalog.apps).map((a) => a.slug)).toEqual(top.apps.map((a) => a.slug));
  });
});
