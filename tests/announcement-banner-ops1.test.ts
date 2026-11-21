/**
 * OPS1: the in-app announcement strip (web/components/announcement-banner.tsx), rendered to static markup like the
 * other component tests: window, audience, tone, link, dismiss per announcement id, and blocked storage.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnnouncementBanner, ANNOUNCEMENT_DISMISSED_KEY } from "../src/web/components/announcement-banner";
import type { PublicAnnouncement } from "../src/shared/announcement";

const NOW = new Date("2026-11-21T10:00:00Z");
const base: PublicAnnouncement = { id: "ann_1", text: "Scheduled maintenance tonight.", tone: "info", audience: "all", linkLabel: null, linkUrl: null, startsAt: null, endsAt: null, dismissible: true };
const render = (a: PublicAnnouncement | null, role: string | null = "member") => renderToStaticMarkup(createElement(AnnouncementBanner, { announcement: a, role, now: NOW }));

function stubStorage(store: Record<string, string>, throws = false) {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => { if (throws) throw new Error("blocked"); return store[k] ?? null; },
    setItem: (k: string, v: string) => { if (throws) throw new Error("blocked"); store[k] = v; },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("AnnouncementBanner", () => {
  it("renders nothing without an announcement, outside its window, or outside its audience", () => {
    expect(render(null)).toBe("");
    expect(render({ ...base, startsAt: "2026-11-21T11:00:00Z" })).toBe("");
    expect(render({ ...base, endsAt: "2026-11-21T09:00:00Z" })).toBe("");
    expect(render({ ...base, audience: "admins" }, "member")).toBe("");
    expect(render({ ...base, audience: "admins" }, null)).toBe("");
    expect(render({ ...base, audience: "admins" }, "admin")).toContain("Scheduled maintenance tonight.");
    expect(render({ ...base, audience: "admins" }, "owner")).toContain("Scheduled maintenance tonight.");
  });

  it("info and warning are a status, critical is an alert, each in its badge tone", () => {
    const info = render(base);
    expect(info).toContain('role="status"');
    expect(info).toContain("bg-brand-soft");
    const warn = render({ ...base, tone: "warning" });
    expect(warn).toContain('role="status"');
    expect(warn).toContain("bg-warn-soft");
    const crit = render({ ...base, tone: "critical" });
    expect(crit).toContain('role="alert"');
    expect(crit).toContain("bg-bad-soft");
  });

  it("shows a labelled link that opens safely and a labelled dismiss button", () => {
    const html = render({ ...base, linkLabel: "Read more", linkUrl: "https://multies.si/news" });
    expect(html).toContain('href="https://multies.si/news"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">Read more</a>");
    expect(html).toContain('aria-label="Dismiss announcement"');
    expect(html).toContain('type="button"');
  });

  it("drops a link that is not https and the button when it cannot be dismissed", () => {
    const html = render({ ...base, linkLabel: "Bad", linkUrl: "javascript:alert(1)", dismissible: false });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("announcement-link");
    expect(html).not.toContain("announcement-dismiss");
  });

  it("stays hidden once dismissed in this browser, but a new announcement shows", () => {
    stubStorage({ [ANNOUNCEMENT_DISMISSED_KEY]: "ann_1" });
    expect(render(base)).toBe("");
    expect(render({ ...base, id: "ann_2" })).toContain("Scheduled maintenance tonight.");
    // One that cannot be dismissed shows even with a stale dismissal.
    expect(render({ ...base, dismissible: false })).toContain("Scheduled maintenance tonight.");
  });

  it("blocked storage still renders", () => {
    stubStorage({}, true);
    expect(render(base)).toContain("Scheduled maintenance tonight.");
  });

  it("the text is escaped, never markup", () => {
    expect(render({ ...base, text: "<img src=x onerror=alert(1)>" })).not.toContain("<img");
  });
});
