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
    // R125: "Share dashboards, email reports" (the oldest after What's new itself) made room for Tables in Docs.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-dashboards-plus")).toBe(false);
    // R69: the list stays at 14, so the oldest entry after What's new itself ("Tell the command menu what to do") made room.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-28-command-menu-actions")).toBe(false);
    // R85: the oldest after What's new itself made room for Inbox tabs, labels and mail rules.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-tools-one-look")).toBe(false);
    // R84: "Pick how small" (compress levels) merged into "Tools that tell you sooner" to make room for saved views, tags and the task page.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-compress-levels")).toBe(false);
    // R83: "Tools pages and forms" made room for TikTok and Threads.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-30-tools-pages-forms")).toBe(false);
    // R86: "Compress levels" made room for Tools round B.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-compress-levels")).toBe(false);
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
    // R86: "Tools that tell you sooner" made room for Video, sound, ebooks, archives and Edit a PDF.
    // R88: "Split in one tap" made room for secure share (the list stays at 14).
    // R87: "A clearer timeline" folded into "A home for developers" to make room for Links (both still in CHANGELOG.md).
    // R89: "A home for developers" made room for whiteboards, diagrams, mind maps and slides (still in CHANGELOG.md).
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-developers-faster-pages")).toBe(false);
    // R117: "Post to TikTok and Threads" folded into "Plan social posts by the week" (still in CHANGELOG.md).
    for (const id of ["2026-10-31-tools-smoother", "2026-10-31-split-keep-faster", "2026-10-31-timeline-views", "2026-10-31-tiktok-threads", "2026-10-31-convert-any-file"]) expect(WHATS_NEW.some((e) => e.id === id), id).toBe(false);
    // R94: "2026-10-31-workspace-brand" (the oldest after What's new itself) made room for the CRM timeline; it stays in CHANGELOG.md.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-workspace-brand")).toBe(false);
    // R107: "A calmer layout you can shape" (the oldest after What's new itself) made room for signing v2.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-calm-layout")).toBe(false);
    // R97: the oldest after What's new itself ("Inbox tabs, mail rules and a helpdesk") made room for the notification centre.
    // R91: "2026-10-31-tasks-views-tags" (the oldest after What's new itself) made room for dashboards plus; it stays in CHANGELOG.md.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-tasks-views-tags")).toBe(false);
    // R120: "2026-10-31-social-home" (the oldest after What's new itself) made room for client portals; it stays in CHANGELOG.md.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-social-home")).toBe(false);
    // R96: Chat plus took the place of "2026-10-31-tools-round-b" to keep the list at 14.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-tools-round-b")).toBe(false);
    // R103: the oldest after What's new itself (2026-10-31-links) made room for the link library, comments and spelling.
    // R111: Archive and retention took the place of the oldest after What's new itself ("2026-10-31-docs-visual"); it stays in CHANGELOG.md.
    // R115: "2026-10-31-secure-share" (the oldest after What's new itself) made room for maps and visits.
    // R115 (rebased on R111): "2026-10-31-automation-flows" (the oldest after What's new itself) made room for maps and visits; it stays in CHANGELOG.md.
    // R109: newsletters joined at the top; "Social planner library", the oldest after What's new itself, made room; it stays in CHANGELOG.md.
    for (const gone of ["2026-10-31-docs-visual", "2026-10-31-secure-share", "2026-10-31-automation-flows", "2026-10-31-social-planner-library"]) expect(WHATS_NEW.some((e) => e.id === gone), gone).toBe(false);
    // R101: Files plus took the place of "2026-10-31-crm-timeline"; R95: "2026-10-31-tools-round-c" made room for Tasks plus; R105: invoices and quotes joined at the top and "2026-10-31-esign-v2" (the oldest after What's new itself) made room. All stay in CHANGELOG.md.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-tools-round-c")).toBe(false);
    // R108: Contracts merged the e-signing entry ("2026-10-31-esign-v2") into its own. R105: invoices and quotes joined at the top and "2026-11-01-help-center" (the oldest after What's new itself) made room; it stays in CHANGELOG.md.
    expect(WHATS_NEW.some((e) => e.id === "2026-10-31-esign-v2")).toBe(false);
    // R110: Ask joined, so the oldest after What's new itself (Help center) made room. R105: invoices and quotes joined at the top and "2026-11-01-notification-centre" made room; both stay in CHANGELOG.md.
    // R92: booking plus joined at the top; "2026-11-01-dashboards-plus", the oldest after What's new itself, made room (it stays in CHANGELOG.md).
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-dashboards-plus")).toBe(false);
    // R125: tables joined at the top; "2026-11-01-client-portals", the oldest after What's new itself, made room (it stays in CHANGELOG.md).
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-client-portals")).toBe(false);
    // W1B: the three items shipped last on 1 Nov 14:32 to 15:37 UTC (office files, faster search, clear errors) joined above booking plus; 2026-11-01-docs-plus, 2026-11-01-dav-sync, 2026-11-01-chat-plus, the oldest after What's new itself, moved to the public earlier list (whats-new-public.ts).
    // R93: forms that chat, feedback boards and calls for submissions joined at the top; "2026-11-01-mail-archive" (the oldest after What's new itself) moved to the public earlier list.
    // R123: Sites joined at the top; "2026-11-01-maps-visits" (the oldest after What's new itself) moved to the public earlier list.
    // R112: anonymous reports joined at the top; "2026-11-01-contracts" (the oldest after What's new itself) moved to the public earlier list.
    // R129: courses joined at the top; "2026-11-01-files-plus" (the oldest after What's new itself) moved to the public earlier list.
    // R114: webinars joined at the top; "2026-11-01-tasks-plus" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-tasks-plus")).toBe(false);
    // R124: the blog joined at the top; "2026-11-01-ask-workspace" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-ask-workspace")).toBe(false);
    // POL1: the polish round joined at the top; "2026-11-01-tables" (the oldest after What's new itself that the W1b order test does not pin) moved out; its news is in the polish line and CHANGELOG.md.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-tables")).toBe(false);
    // TD3: meetings to tasks joined at the top; "2026-11-01-forms-plus" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-forms-plus")).toBe(false);
    // TD5: mentions joined at the top; "2026-11-02-courses" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-02-courses")).toBe(false);
    // TD6: one inbox joined at the top; "2026-11-02-home-widgets" moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-02-home-widgets")).toBe(false);
    // TD7: branded forms joined at the top; "2026-11-02-webinars" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-02-webinars")).toBe(false);
    // TD8: Team AI joined at the top; "2026-11-02-anonymous-reports" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-02-anonymous-reports")).toBe(false);
    // TD10: contacts from mail joined at the top; "2026-11-02-blog" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-02-blog")).toBe(false);
    expect(WHATS_NEW.map((e) => e.id)).toEqual(["2026-11-03-crm-from-mail", "2026-11-03-team-ai", "2026-11-03-forms-pro", "2026-11-02-one-inbox", "2026-11-02-mentions", "2026-11-02-bill-time", "2026-11-02-meeting-tasks", "2026-11-02-ai-connect", "2026-11-02-get-started", "2026-11-02-staff", "2026-11-02-polish", "2026-11-02-menu", "2026-11-02-social-more-networks", "2026-10-28-whats-new"]);
    // TD4: bill time joined at the top; "2026-11-01-sites" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-sites")).toBe(false);
    // R132: more from Social joined at the top; "2026-11-01-invoices" (the oldest after What's new itself) moved to the public earlier list.
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-invoices")).toBe(false);
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-contracts")).toBe(false);
    expect(WHATS_NEW.some((e) => e.id === "2026-11-01-help-center")).toBe(false);
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
