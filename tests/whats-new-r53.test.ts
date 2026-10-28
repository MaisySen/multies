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
  // R54: a few entries land each round; prune the oldest once the list passes 20.
  it("has 8 to 20 entries with unique ids", () => {
    expect(WHATS_NEW.length).toBeGreaterThanOrEqual(8);
    expect(WHATS_NEW.length).toBeLessThanOrEqual(20);
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

  it("carries the R53 entries: What's new itself, then the mail sync change (R54 entries sit above them)", () => {
    const i = WHATS_NEW.findIndex((e) => e.id === "2026-10-28-whats-new");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(WHATS_NEW[i + 1].title).toMatch(/mail sync/i);
    expect(WHATS_NEW[i + 1].body).toMatch(/not downloaded again/);
    expect(WHATS_NEW[0].id).toBe("2026-10-28-more-safe-retries");
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
