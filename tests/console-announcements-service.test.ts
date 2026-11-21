/**
 * OPS1: the in-app announcement service (services/console/announcements.ts) and its shared rules
 * (shared/announcement.ts): publish, window, audience, clear, strict validation, the public shape and no write on read.
 */
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestApp } from "./helpers";
import { appSettings } from "../src/server/db/schema";
import { HttpError } from "../src/server/lib/errors";
import {
  ANNOUNCEMENT_CACHE_MS, ANNOUNCEMENT_KEY, accountAnnouncement, clearAnnouncement, getAnnouncement, publicAnnouncement, publishAnnouncement, resetAnnouncementCache,
} from "../src/server/services/console/announcements";
import { isAnnouncementActive, viewerAudience, type Announcement } from "../src/shared/announcement";

const actor = { userId: "usr_op1", email: "op@example.com" };
const T0 = new Date("2026-11-21T10:00:00.000Z");

async function setup() {
  const { deps } = await makeTestApp();
  let now = T0;
  const d = { ...deps, now: () => now };
  return { deps: d, setNow: (t: Date) => { now = t; } };
}

async function rejects(p: Promise<unknown>, field?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(422);
  if (field) expect(Object.keys(((err as HttpError).details as { fields: Record<string, string> }).fields)).toContain(field);
  return err as HttpError;
}

describe("publish and read", () => {
  it("stores one announcement with defaults and returns before and after", async () => {
    const { deps } = await setup();
    expect(await getAnnouncement(deps)).toBeNull();
    const first = await publishAnnouncement(deps, { text: "  Scheduled maintenance tonight at 22:00 UTC.  " }, actor);
    expect(first.before).toBeNull();
    expect(first.after).toMatchObject({ text: "Scheduled maintenance tonight at 22:00 UTC.", tone: "info", audience: "all", linkLabel: null, linkUrl: null, startsAt: null, endsAt: null, dismissible: true, updatedBy: "usr_op1", updatedAt: T0.toISOString() });
    expect(first.after!.id).toMatch(/^ann/);
    expect(await getAnnouncement(deps)).toEqual(first.after);

    const second = await publishAnnouncement(deps, { text: "Mail is delayed.", tone: "warning", linkLabel: "Status", linkUrl: "https://status.multies.si/", dismissible: false }, actor);
    expect(second.before).toEqual(first.after);
    expect(second.after!.id).not.toBe(first.after!.id);
    expect(second.after).toMatchObject({ tone: "warning", linkLabel: "Status", linkUrl: "https://status.multies.si/", dismissible: false });
    // One row, replaced in place.
    const rows = await deps.db.select().from(appSettings).where(eq(appSettings.key, ANNOUNCEMENT_KEY)).all();
    expect(rows).toHaveLength(1);
  });

  it("clear removes it and returns before; a second clear writes nothing", async () => {
    const { deps } = await setup();
    const { after } = await publishAnnouncement(deps, { text: "Hello" }, actor);
    const c1 = await clearAnnouncement(deps, actor);
    expect(c1).toEqual({ before: after, after: null });
    expect(await getAnnouncement(deps)).toBeNull();
    expect(await publicAnnouncement(deps)).toBeNull();
    const del = vi.spyOn(deps.db, "delete");
    expect(await clearAnnouncement(deps, actor)).toEqual({ before: null, after: null });
    expect(del).not.toHaveBeenCalled();
  });
});

describe("window and audience", () => {
  it("publicAnnouncement shows only between startsAt and endsAt", async () => {
    const { deps } = await setup();
    await publishAnnouncement(deps, { text: "Window", startsAt: "2026-11-21T12:00:00Z", endsAt: "2026-11-21T14:00:00.000Z" }, actor);
    expect(await publicAnnouncement(deps, new Date("2026-11-21T11:59:59Z"))).toBeNull();
    expect((await publicAnnouncement(deps, new Date("2026-11-21T12:00:00Z")))?.text).toBe("Window");
    expect((await publicAnnouncement(deps, new Date("2026-11-21T13:59:59Z")))?.text).toBe("Window");
    expect(await publicAnnouncement(deps, new Date("2026-11-21T14:00:00Z"))).toBeNull();
    // The console still sees an ended announcement.
    expect((await getAnnouncement(deps))?.endsAt).toBe("2026-11-21T14:00:00.000Z");
  });

  it("isAnnouncementActive applies the audience: admins-only shows to owners and admins", () => {
    const a = { audience: "admins" as const, startsAt: null, endsAt: null };
    expect(viewerAudience("owner")).toBe("admins");
    expect(viewerAudience("admin")).toBe("admins");
    expect(viewerAudience("member")).toBe("all");
    expect(viewerAudience(undefined)).toBe("all");
    expect(isAnnouncementActive(a, T0, "admins")).toBe(true);
    expect(isAnnouncementActive(a, T0, "all")).toBe(false);
    expect(isAnnouncementActive({ ...a, audience: "all" }, T0, "all")).toBe(true);
    // Without a viewer only the window counts (the server side check).
    expect(isAnnouncementActive(a, T0)).toBe(true);
    expect(isAnnouncementActive(null, T0)).toBe(false);
  });

  it("an admins-only announcement is never public; accountAnnouncement gives it to workspace owners and admins only", async () => {
    const { deps } = await setup();
    await publishAnnouncement(deps, { text: "For admins", audience: "admins" }, actor);
    expect(await publicAnnouncement(deps)).toBeNull();
    expect(await publicAnnouncement(deps, T0)).toBeNull();
    expect((await accountAnnouncement(deps, T0, "owner"))?.text).toBe("For admins");
    expect((await accountAnnouncement(deps, T0, "admin"))?.audience).toBe("admins");
    expect(await accountAnnouncement(deps, T0, "member")).toBeNull();
    expect(await accountAnnouncement(deps, T0, "guest")).toBeNull();
    expect(await accountAnnouncement(deps, T0, null)).toBeNull();
  });

  it("an announcement for everyone is public and reaches every signed in role, inside its window only", async () => {
    const { deps } = await setup();
    await publishAnnouncement(deps, { text: "Everyone", startsAt: "2026-11-21T12:00:00Z" }, actor);
    expect(await accountAnnouncement(deps, T0, "owner")).toBeNull();
    const at = new Date("2026-11-21T12:00:00Z");
    expect((await publicAnnouncement(deps, at))?.text).toBe("Everyone");
    for (const role of ["owner", "admin", "member", "guest", null]) expect((await accountAnnouncement(deps, at, role))?.text).toBe("Everyone");
    const pub = await accountAnnouncement(deps, at, "owner");
    expect(pub).not.toHaveProperty("updatedBy");
  });
});

describe("validation", () => {
  it("refuses empty, long, HTML, multi line and unknown fields", async () => {
    const { deps } = await setup();
    await rejects(publishAnnouncement(deps, {}, actor), "text");
    await rejects(publishAnnouncement(deps, { text: "   " }, actor), "text");
    await rejects(publishAnnouncement(deps, { text: "x".repeat(241) }, actor), "text");
    await rejects(publishAnnouncement(deps, { text: "Hi <b>there</b>" }, actor), "text");
    await rejects(publishAnnouncement(deps, { text: "<script>alert(1)</script>" }, actor), "text");
    await rejects(publishAnnouncement(deps, { text: "two\nlines" }, actor), "text");
    await rejects(publishAnnouncement(deps, { text: "ok", html: "<p>" }, actor));
    await rejects(publishAnnouncement(deps, { text: "ok", tone: "danger" }, actor), "tone");
    await rejects(publishAnnouncement(deps, { text: "ok", audience: "members" }, actor), "audience");
    await rejects(publishAnnouncement(deps, { text: "ok", dismissible: "yes" }, actor), "dismissible");
    expect(await publishAnnouncement(deps, { text: "x".repeat(240) }, actor)).toBeTruthy();
  });

  it("refuses links that are not https, have credentials, or lack a label", async () => {
    const { deps } = await setup();
    for (const linkUrl of ["http://example.com", "javascript:alert(1)", "data:text/html,hi", "//example.com", "example.com", "https://user:pw@example.com/", "ftp://example.com"]) {
      await rejects(publishAnnouncement(deps, { text: "ok", linkLabel: "Open", linkUrl }, actor), "linkUrl");
    }
    await rejects(publishAnnouncement(deps, { text: "ok", linkUrl: "https://example.com" }, actor), "linkLabel");
    await rejects(publishAnnouncement(deps, { text: "ok", linkLabel: "Open" }, actor), "linkUrl");
    await rejects(publishAnnouncement(deps, { text: "ok", linkLabel: "<i>Open</i>", linkUrl: "https://example.com" }, actor), "linkLabel");
    await rejects(publishAnnouncement(deps, { text: "ok", linkLabel: "x".repeat(41), linkUrl: "https://example.com" }, actor), "linkLabel");
  });

  it("refuses bad times and an end before the start; nothing is written", async () => {
    const { deps } = await setup();
    await rejects(publishAnnouncement(deps, { text: "ok", startsAt: "tomorrow" }, actor), "startsAt");
    await rejects(publishAnnouncement(deps, { text: "ok", endsAt: "2026-13-40T00:00:00Z" }, actor), "endsAt");
    await rejects(publishAnnouncement(deps, { text: "ok", startsAt: "2026-11-22T00:00:00Z", endsAt: "2026-11-21T00:00:00Z" }, actor), "endsAt");
    await rejects(publishAnnouncement(deps, { text: "ok", startsAt: "2026-11-22T00:00:00Z", endsAt: "2026-11-22T00:00:00Z" }, actor), "endsAt");
    expect(await getAnnouncement(deps)).toBeNull();
  });
});

describe("public shape and reads", () => {
  it("carries only the public fields", async () => {
    const { deps } = await setup();
    await publishAnnouncement(deps, { text: "Hi", linkLabel: "More", linkUrl: "https://multies.si/news" }, actor);
    const pub = await publicAnnouncement(deps);
    expect(Object.keys(pub!).sort()).toEqual(["audience", "dismissible", "endsAt", "id", "linkLabel", "linkUrl", "startsAt", "text", "tone"]);
    expect(JSON.stringify(pub)).not.toContain("usr_op1");
    expect(pub).not.toHaveProperty("updatedBy");
    expect(pub).not.toHaveProperty("updatedAt");
  });

  it("reads never write, and the public read is cached per isolate for the TTL", async () => {
    const { deps, setNow } = await setup();
    await publishAnnouncement(deps, { text: "Cached" }, actor);
    resetAnnouncementCache(deps);
    const writes = [vi.spyOn(deps.db, "insert"), vi.spyOn(deps.db, "update"), vi.spyOn(deps.db, "delete"), vi.spyOn(deps.db, "run")];
    const select = vi.spyOn(deps.db, "select");
    expect((await publicAnnouncement(deps))?.text).toBe("Cached");
    expect((await publicAnnouncement(deps))?.text).toBe("Cached");
    expect(select).toHaveBeenCalledTimes(1);
    await getAnnouncement(deps);
    for (const w of writes) expect(w).not.toHaveBeenCalled();

    // A change made by another isolate (straight to the row) shows after the TTL.
    for (const w of writes) w.mockRestore();
    await deps.db.update(appSettings).set({ value: JSON.stringify({ ...(await getAnnouncement(deps))!, text: "Changed" } satisfies Announcement) }).where(eq(appSettings.key, ANNOUNCEMENT_KEY));
    // getAnnouncement above refreshed the cache with the old row; within the TTL the old text stays.
    setNow(new Date(T0.getTime() + ANNOUNCEMENT_CACHE_MS - 1));
    expect((await publicAnnouncement(deps))?.text).toBe("Cached");
    setNow(new Date(T0.getTime() + ANNOUNCEMENT_CACHE_MS + 1));
    expect((await publicAnnouncement(deps))?.text).toBe("Changed");
  });

  it("a publish or clear in this isolate shows at once", async () => {
    const { deps } = await setup();
    expect(await publicAnnouncement(deps)).toBeNull();
    await publishAnnouncement(deps, { text: "Now" }, actor);
    expect((await publicAnnouncement(deps))?.text).toBe("Now");
    await clearAnnouncement(deps, actor);
    expect(await publicAnnouncement(deps)).toBeNull();
  });

  it("a malformed stored row reads as no announcement", async () => {
    const { deps } = await setup();
    await deps.db.insert(appSettings).values({ key: ANNOUNCEMENT_KEY, value: "{not json" });
    expect(await getAnnouncement(deps)).toBeNull();
    await deps.db.update(appSettings).set({ value: JSON.stringify({ id: "a", text: "x", tone: "loud", audience: "all" }) }).where(eq(appSettings.key, ANNOUNCEMENT_KEY));
    resetAnnouncementCache(deps);
    expect(await publicAnnouncement(deps)).toBeNull();
  });
});
