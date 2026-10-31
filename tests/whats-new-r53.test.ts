import { describe, expect, it, vi, beforeEach } from "vitest";
import { WHATS_NEW, formatWhatsNewDate, hasUnreadWhatsNew, latestWhatsNewId, type WhatsNewEntry } from "../src/shared/whats-new";
import { DASHES, FOREIGN_HOST, SLOP } from "../scripts/check-copy";

// Names that must not appear in What's new copy: other work and mail tools (import sources included) and AI vendors.
const BANNED_NAMES = [
  "Gmail", "Google", "Outlook", "Microsoft", "Apple", "Yahoo", "Proton", "Fastmail", "Zoho", "Takeout",
  "Asana", "Trello", "Jira", "Atlassian", "Linear", "Notion", "ClickUp", "Monday", "Basecamp", "Slack", "Teams", "Zoom",
  "Front", "Missive", "Superhuman", "Hey", "Plane", "Twenty", "Cal.com", "Documenso", "Cloudflare",
  "OpenAI", "ChatGPT", "GPT", "Claude", "Anthropic", "Gemini", "Copilot", "Mistral", "Llama",
];
const SLOP_RE = new RegExp(`\\b(${SLOP.map((w) => w.replace(/[-']/g, (c) => `\\${c}`).replace(/ /g, "\\s+")).join("|")})\\b`, "i");
const words = (e: WhatsNewEntry) => `${e.title} ${e.body}`;

describe("R53 whats-new list", () => {
  // R54: a few entries land each round. R55: pruned to what people can see and use; keep it at 14 or fewer.
  it("has 8 to 14 entries with unique ids", () => {
    expect(WHATS_NEW.length).toBeGreaterThanOrEqual(8);
    expect(WHATS_NEW.length).toBeLessThanOrEqual(14);
    expect(new Set(WHATS_NEW.map((e) => e.id)).size).toBe(WHATS_NEW.length);
  });

  it("uses real calendar dates, newest first", () => {
    for (const e of WHATS_NEW) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const d = new Date(`${e.date}T00:00:00Z`);
      expect(d.toISOString().slice(0, 10)).toBe(e.date);
      expect(e.id.startsWith(e.date)).toBe(true);
    }
    const dates = WHATS_NEW.map((e) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("keeps each entry short: a title and one to three sentences", () => {
    for (const e of WHATS_NEW) {
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.title.length).toBeLessThanOrEqual(60);
      const sentences = e.body.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length, e.id).toBeGreaterThanOrEqual(1);
      expect(sentences.length, e.id).toBeLessThanOrEqual(3);
      expect(e.body.trim().endsWith(".")).toBe(true);
    }
  });

  it("has no dashes of any kind: no em or en dash, no hyphen used as a dash", () => {
    for (const e of WHATS_NEW) {
      expect(DASHES.test(words(e)), e.id).toBe(false);
      expect(/\s-+\s|--|^-|-$/.test(e.title) || /\s-+\s|--/.test(e.body), e.id).toBe(false);
      expect(/[A-Za-z]-[A-Za-z]/.test(words(e)), `${e.id}: hyphenated word`).toBe(false);
    }
  });

  it("names no other product or AI vendor, uses no stock phrases, and no foreign host", () => {
    for (const e of WHATS_NEW) {
      for (const n of BANNED_NAMES) expect(new RegExp(`\\b${n.replace(".", "\\.")}\\b`, "i").test(words(e)), `${e.id}: ${n}`).toBe(false);
      expect(SLOP_RE.test(words(e)), e.id).toBe(false);
      expect(FOREIGN_HOST.test(words(e))).toBe(false);
      expect(/\bMyMail\b/.test(words(e))).toBe(false);
    }
  });

  it("keeps What's new itself; R55 pruned the entries nobody can see (they stay in CHANGELOG.md)", () => {
    expect(WHATS_NEW.some((e) => e.id === "2026-10-28-whats-new")).toBe(true);
    // R69: the list stays at 14, so the oldest entry after What's new itself ("Tell the command menu what to do") made room.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-28-command-menu-actions")).toBe(false);
    // R85: the oldest after What's new itself made room for Inbox tabs, labels and mail rules.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-tools-one-look")).toBe(false);
    // R84: "Pick how small" (compress levels) merged into "Tools that tell you sooner" to make room for saved views, tags and the task page.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-compress-levels")).toBe(false);
    // R83: "Tools pages and forms" made room for TikTok and Threads.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-tools-pages-forms")).toBe(false);
    // R70: "Reply straight from the shared inbox" made room for compress levels.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-29-inbox-reply")).toBe(false);
    // R71: "Your whole mailbox syncs by itself" made room for the QA pass 6 fixes.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-29-full-mailbox-sync")).toBe(false);
    // R78: "Clearer legal pages" made room for Convert any file.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-clearer-legal")).toBe(false);
    // R74: "Free for a small team, and easy to move in" made room for Split choices and the kept file.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-29-free-and-switch")).toBe(false);
    // R75: "Share a guest invite yourself" made room for the clearer timeline.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-29-guest-link")).toBe(false);
    // R76: "Other tabs follow your workspace" made room for the developer hub and faster public pages.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-29-workspace-tabs")).toBe(false);
    // R77: "Older mail shows its sender and subject" made room for workspace branding.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-older-mail-headers")).toBe(false);
    // R79: "Tools for your documents" made room for the calmer layout.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-tools")).toBe(false);
    // R81B: "Pay yearly, get two months free" made room for Multies everywhere.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-yearly-and-referrals")).toBe(false);
    // R80C: "More tools" made room for Connections.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-tools-more")).toBe(false);
    // R82F: "Share links, workflows and templates" made room for One place for everything you connect.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-tools-share-workflows")).toBe(false);
    // P1 layout: "Connections" folded into "Social has its own place" (still in CHANGELOG.md).
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-connections")).toBe(false);
    expect(WHATS_NEW[0].id).toBe("2026-10-31-social-home");
    expect(WHATS_NEW[1].id).toBe("2026-10-31-tasks-views-tags");
    expect(WHATS_NEW[2].id).toBe("2026-10-31-inbox-tabs-rules");
    expect(WHATS_NEW[3].id).toBe("2026-10-31-tiktok-threads");
    expect(WHATS_NEW[4].id).toBe("2026-10-31-one-place-connections");
    expect(WHATS_NEW[5].id).toBe("2026-10-31-multies-everywhere");
    expect(WHATS_NEW[6].id).toBe("2026-10-31-calm-layout");
    expect(WHATS_NEW[7].id).toBe("2026-10-31-convert-any-file");
    expect(WHATS_NEW[8].id).toBe("2026-10-31-workspace-brand");
    for (const id of ["2026-10-28-more-safe-retries", "2026-10-28-lighter-mail-sync", "2026-10-28-safe-retries", "2026-10-28-quicker-task-lists", "2026-10-27-steadier-my-work"]) {
      expect(WHATS_NEW.some((e) => e.id === id), id).toBe(false);
    }
    // Newest first.
    expect([...WHATS_NEW].sort((a, b) => b.date.localeCompare(a.date)).map((e) => e.date)).toEqual(WHATS_NEW.map((e) => e.date));
  });

  it("formats a date as a calendar day without a time zone shift", () => {
    expect(formatWhatsNewDate("2026-10-28", "en-GB")).toBe("28 Oct 2026");
    expect(formatWhatsNewDate("2026-01-01", "en-GB")).toBe("1 Jan 2026");
  });
});

describe("R53 whats-new unread dot", () => {
  const list: WhatsNewEntry[] = [
    { id: "2026-10-28-b", date: "2026-10-28", title: "Bee", body: "B." },
    { id: "2026-10-27-a", date: "2026-10-27", title: "Ay", body: "A." },
  ];
  it("shows when nothing was ever opened", () => {
    expect(hasUnreadWhatsNew(null, list)).toBe(true);
    expect(hasUnreadWhatsNew(undefined, list)).toBe(true);
  });
  it("hides once the newest id was opened, and shows again when a newer entry ships", () => {
    expect(hasUnreadWhatsNew("2026-10-28-b", list)).toBe(false);
    expect(hasUnreadWhatsNew("2026-10-27-a", list)).toBe(true);
    expect(hasUnreadWhatsNew("2026-10-28-b", [{ id: "2026-10-29-c", date: "2026-10-29", title: "See", body: "C." }, ...list])).toBe(true);
  });
  it("never shows for an empty list", () => {
    expect(latestWhatsNewId([])).toBeNull();
    expect(hasUnreadWhatsNew(null, [])).toBe(false);
  });
});

describe("R53 whats-new seen state (localStorage only)", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });
  it("markWhatsNewSeen stores the newest id under one key and nothing else", async () => {
    const { markWhatsNewSeen, WHATS_NEW_SEEN_KEY } = await import("../src/web/lib/whats-new");
    markWhatsNewSeen();
    expect(store).toEqual({ [WHATS_NEW_SEEN_KEY]: WHATS_NEW[0].id });
    expect(hasUnreadWhatsNew(store[WHATS_NEW_SEEN_KEY])).toBe(false);
  });
  it("survives blocked storage", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    const { markWhatsNewSeen } = await import("../src/web/lib/whats-new");
    expect(() => markWhatsNewSeen()).not.toThrow();
  });
});
