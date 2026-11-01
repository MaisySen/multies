import { describe, expect, it } from "vitest";
import { WHATS_NEW, latestWhatsNewId, type WhatsNewEntry } from "../src/shared/whats-new";
import { WHATS_NEW_EARLIER, publicWhatsNew } from "../src/shared/whats-new-public";

// W1B: the public What's new page lists today's newest items at the top, newest first, same day order kept.
const e = (id: string, date: string): WhatsNewEntry => ({ id, date, title: id, body: "x." });

describe("W1B public whats new order", () => {
  const list = publicWhatsNew();
  const ids = list.map((x) => x.id);

  it("is newest first by date with every entry once", () => {
    const dates = list.map((x) => x.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(new Set(ids).size).toBe(ids.length);
    for (const x of [...WHATS_NEW, ...WHATS_NEW_EARLIER]) expect(ids, x.id).toContain(x.id);
  });

  it("keeps same day entries in written order, in app list first", () => {
    const out = publicWhatsNew([e("a", "2026-11-01"), e("b", "2026-11-01")], [e("c", "2026-11-02"), e("d", "2026-11-01"), e("a", "2026-11-01")]);
    expect(out.map((x) => x.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("puts the last three items shipped on 1 Nov above everything else shipped that day", () => {
    const newest = ["2026-11-01-clear-errors", "2026-11-01-faster-search", "2026-11-01-office-files"];
    const at = newest.map((id) => ids.indexOf(id));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // Shipped on 1 Nov before 14:32 UTC; items shipped later (Tables and on) may sit above the three.
    const earlier = ["booking-plus", "invoices", "ask-workspace", "contracts", "tasks-plus", "newsletters", "files-plus", "maps-visits", "mail-archive", "docs-plus", "dav-sync", "chat-plus", "client-portals", "search", "dashboards", "social-inbox"];
    const older = earlier.map((s) => `2026-11-01-${s}`).filter((id) => ids.includes(id));
    expect(older.length).toBeGreaterThan(10);
    for (const id of older) expect(ids.indexOf(id), id).toBeGreaterThan(at[2]);
  });

  it("starts with the newest in app entry, so the unread dot matches the page", () => {
    expect(ids[0]).toBe(latestWhatsNewId());
  });
});
