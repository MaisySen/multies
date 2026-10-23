import { clock, duration, elapsed, parseMinutes } from "@/lib/time";
import { isLive, meetingWhen } from "@/lib/meetings";
import { SampleTransport } from "@/sample/transport";
import type { Meeting, TaskView, TimeEntry } from "@/api/types";

describe("time formats", () => {
  it("shows mm:ss under an hour, then h:mm", () => {
    expect(clock(0)).toBe("00:00");
    expect(clock(247)).toBe("04:07");
    expect(clock(3599)).toBe("59:59");
    expect(clock(3600)).toBe("1:00");
    expect(clock(3900 + 59)).toBe("1:05");
    expect(clock(-5)).toBe("00:00");
  });
  it("shows totals in hours and minutes", () => {
    expect(duration(0)).toBe("0m");
    expect(duration(45 * 60)).toBe("45m");
    expect(duration(2 * 3600)).toBe("2h");
    expect(duration(85 * 60)).toBe("1h 25m");
  });
  it("counts a running timer from its start", () => {
    const start = Date.parse("2026-10-24T09:00:00Z");
    expect(elapsed({ running: true, seconds: 0, startedAt: new Date(start).toISOString() }, start + 125_000)).toBe(125);
    expect(elapsed({ running: false, seconds: 600, startedAt: new Date(start).toISOString() }, start + 125_000)).toBe(600);
  });
  it("reads minutes or h:mm and refuses nonsense", () => {
    expect(parseMinutes("30")).toBe(30);
    expect(parseMinutes(" 1:15 ")).toBe(75);
    expect(parseMinutes("2.5")).toBe(2.5);
    for (const bad of ["", "0", "-4", "abc", "1441", "1:5"]) expect(parseMinutes(bad)).toBeNull();
  });
});

describe("meeting helpers", () => {
  const m = { startsAt: "2026-10-27T03:30:00Z", endsAt: "2026-10-27T04:00:00Z", durationMin: 30, status: "scheduled" } as Meeting;
  it("is live from 10 minutes before until it ends", () => {
    expect(isLive(m, Date.parse("2026-10-27T03:15:00Z"))).toBe(false);
    expect(isLive(m, Date.parse("2026-10-27T03:25:00Z"))).toBe(true);
    expect(isLive(m, Date.parse("2026-10-27T04:00:00Z"))).toBe(false);
    expect(isLive({ ...m, status: "cancelled" }, Date.parse("2026-10-27T03:35:00Z"))).toBe(false);
  });
  it("writes the time in en-AU with the length", () => {
    expect(meetingWhen(m)).toMatch(/30 min$/);
  });
});

describe("sample workspace: time and meetings", () => {
  it("runs one timer per person and adds it to the task's total", async () => {
    const t = new SampleTransport();
    const { tasks } = await t.request<{ tasks: { id: string; ref: string }[] }>("GET", "/tasks");
    const [a, b] = tasks;
    const before = await t.request<TaskView>("GET", `/tasks/${a.id}`);
    expect(before.time).toBeDefined();
    expect(before.blockedBy).toEqual([]);
    await t.request("POST", "/time/start", { taskId: a.ref });
    const second = await t.request<{ entry: TimeEntry }>("POST", "/time/start", { taskId: b.id });
    const { entries } = await t.request<{ entries: TimeEntry[] }>("GET", "/time");
    expect(entries.filter((e) => e.running)).toHaveLength(1);
    expect(second.entry.taskId).toBe(b.id);
    const stopped = await t.request<{ entry: TimeEntry | null }>("POST", "/time/stop", {});
    expect(stopped.entry?.running).toBe(false);
    expect((await t.request<{ entry: unknown }>("POST", "/time/stop", {})).entry).toBeNull();
    await t.request("POST", "/time", { taskId: a.id, minutes: 30, note: "Quote" });
    const after = await t.request<TaskView>("GET", `/tasks/${a.id}`);
    expect(after.time!.totalSeconds - before.time!.totalSeconds).toBeGreaterThanOrEqual(30 * 60);
    await expect(t.request("POST", "/time", { taskId: a.id, minutes: 0 })).rejects.toMatchObject({ status: 422 });
  });

  it("makes a meeting from a source with join and guest links", async () => {
    const t = new SampleTransport();
    const { meeting } = await t.request<{ meeting: Meeting }>("POST", "/meetings", { source: { type: "thread", id: "thr_3" }, title: "Invoice call" });
    expect(meeting).toMatchObject({ title: "Invoice call", source: { type: "thread", id: "thr_3" }, videoEnabled: false });
    expect(meeting.joinUrl).toMatch(/^https:\/\/.+\/app\/meetings\//);
    expect(meeting.guestUrl).toMatch(/\/m\//);
    const { meetings, videoEnabled } = await t.request<{ meetings: Meeting[]; videoEnabled: boolean }>("GET", "/meetings?upcoming=1");
    expect(videoEnabled).toBe(false);
    expect(meetings.map((m) => m.id)).toContain(meeting.id);
  });
});
