import { ApiError } from "@/api/errors";
import { badgesFrom, countsClient, type Counts } from "@/lib/counts";
import { collapsed, withAlpha } from "@/components/chrome";
import { ICON_NAMES, iconFamily, iconGlyph } from "@/components/Icon";
import { ICON_PATHS } from "@/components/icon-paths";
import { artFor } from "@/components/empty-art";
import { focusTasks, greeting, nextMeeting, whenLabel } from "@/lib/today";
import type { Meeting, Task } from "@/api/types";

const C: Counts = { mail: { inbox: 4, important: 3, other: 1 }, chat: { unread: 2, mentions: 1 }, notifications: { unread: 5 }, triage: 5, tasks: { dueToday: 2, overdue: 1 }, at: "2026-10-27T00:00:00Z" };
const heads = (etag: string | null) => ({ get: (n: string) => (n.toLowerCase() === "etag" ? etag : null) });

describe("R34 badges from the counts endpoint", () => {
  test("server counts win; approvals come from the list; icon adds mail, activity, chat and approvals", () => {
    expect(badgesFrom(C, { inbox: 99, chat: 99, approvals: 2 })).toEqual({ inbox: 4, chat: 2, mentions: 1, activity: 5, tasks: 3, approvals: 2, icon: 13 });
  });
  test("no server counts: list counts, and junk values count as 0", () => {
    expect(badgesFrom(null, { inbox: 3, chat: -1, mentions: Number.NaN, activity: 2, tasks: 1, approvals: 1 })).toEqual({ inbox: 3, chat: 0, mentions: 0, activity: 2, tasks: 1, approvals: 1, icon: 6 });
  });
  test("sends If-None-Match after the first answer and keeps the last answer on 304", async () => {
    const sent: (Record<string, string> | undefined)[] = [];
    let call = 0;
    const client = countsClient(async (opts) => {
      sent.push(opts.headers);
      call += 1;
      if (call === 1) { opts.onResponse?.(200, heads('W/"a1"')); return C; }
      opts.onResponse?.(304, heads('W/"a1"'));
      throw new ApiError(304, "error", "Not modified");
    });
    expect(await client.get()).toEqual(C);
    expect(await client.get()).toEqual(C);
    expect(sent[0]).toBeUndefined();
    expect(sent[1]).toEqual({ "if-none-match": 'W/"a1"' });
  });
  test("404 answers null and stops asking for 10 minutes", async () => {
    let t = 0, calls = 0;
    const client = countsClient(async () => { calls += 1; throw new ApiError(404, "not_found", "Not found"); }, () => t);
    expect(await client.get()).toBeNull();
    t = 5 * 60_000;
    expect(await client.get()).toBeNull();
    expect(calls).toBe(1);
    t = 11 * 60_000;
    await client.get();
    expect(calls).toBe(2);
  });
  test("other errors still throw", async () => {
    const client = countsClient(async () => { throw new ApiError(500, "error", "Boom"); });
    await expect(client.get()).rejects.toThrow("Boom");
  });
});

describe("R34 icons", () => {
  test("Phosphor on iOS and web, Material Symbols Rounded on Android", () => {
    expect(iconFamily("ios")).toBe("phosphor");
    expect(iconFamily("web")).toBe("phosphor");
    expect(iconFamily("android")).toBe("material");
    expect(iconGlyph("inbox", false, "ios").viewBox).toBe("0 0 256 256");
    expect(iconGlyph("inbox", false, "android").viewBox).toBe("0 -960 960 960");
  });
  test("every icon has four non empty paths, and the filled path differs", () => {
    for (const name of ICON_NAMES) {
      const p = ICON_PATHS[name];
      expect(p).toHaveLength(4);
      for (const d of p) expect(d.length).toBeGreaterThan(10);
    }
    expect(iconGlyph("inbox", true, "ios").d).not.toBe(iconGlyph("inbox", false, "ios").d);
  });
  test("semantic names exist", () => {
    for (const n of ["inbox", "tasks", "chat", "calendar", "settings", "search", "compose", "archive", "snooze", "trash", "flag", "check", "more", "back", "today"]) {
      expect(ICON_NAMES).toContain(n);
    }
  });
  test("empty state art for the main lists", () => {
    expect(artFor("inbox")).toBe("inbox");
    expect(artFor("check-square")).toBe("tasks");
    expect(artFor("message-circle")).toBe("chat");
    expect(artFor("alert-circle")).toBeNull();
  });
});

describe("R34 chrome and Today", () => {
  test("withAlpha and the collapse point", () => {
    expect(withAlpha("#FFFFFF", 0.9)).toBe("rgba(255,255,255,0.9)");
    expect(withAlpha("red", 0.5)).toBe("red");
    expect(collapsed(10)).toBe(false);
    expect(collapsed(60)).toBe(true);
  });
  test("greeting by hour", () => {
    expect(greeting(new Date(2026, 9, 27, 8))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 27, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 27, 20))).toBe("Good evening");
  });
  test("next meeting skips ended and cancelled ones", () => {
    const now = new Date(2026, 9, 27, 10, 0);
    const m = (id: string, h: number, status = "scheduled") => ({ id, title: id, status, startsAt: new Date(2026, 9, 27, h).toISOString(), endsAt: new Date(2026, 9, 27, h, 30).toISOString() }) as unknown as Meeting;
    expect(nextMeeting([m("late", 15), m("past", 8), m("gone", 11, "cancelled"), m("soon", 12)], now)?.id).toBe("soon");
    expect(nextMeeting([], now)).toBeNull();
    expect(whenLabel(new Date(2026, 9, 27, 10, 20).toISOString(), now)).toBe("in 20 min");
    expect(whenLabel(new Date(2026, 9, 27, 9).toISOString(), now)).toBe("Now");
  });
  test("focus tasks: open, due today or earlier, oldest first", () => {
    const t = (id: string, due: string | null, status = "todo") => ({ id, title: id, due, status }) as unknown as Task;
    expect(focusTasks([t("a", "2026-10-27"), t("b", "2026-10-20"), t("c", "2026-10-28"), t("d", "2026-10-01", "done"), t("e", null)], "2026-10-27").map((x) => x.id)).toEqual(["b", "a"]);
  });
});
