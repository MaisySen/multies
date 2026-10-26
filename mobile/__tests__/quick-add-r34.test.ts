import { parseQuickAdd, quickAddToTask } from "@/lib/quick-add";

// Tuesday 27 Oct 2026, 10:00 local.
const NOW = new Date(2026, 9, 27, 10, 0);

describe("R34 quick add parser", () => {
  test("everything at once", () => {
    const r = parseQuickAdd("Call Ana tomorrow 3pm @ana #ops !high", NOW);
    expect(r).toMatchObject({ title: "Call Ana", due: "2026-10-28", time: "15:00", people: ["ana"], project: "ops", priority: "high" });
    expect(r.chips.map((c) => c.kind)).toEqual(["date", "time", "person", "project", "priority"]);
  });
  test("plain text stays plain", () => {
    expect(parseQuickAdd("Write the launch post", NOW)).toMatchObject({ title: "Write the launch post", due: null, time: null, people: [], project: null, priority: null, chips: [] });
  });
  test("weekdays: the coming one, and next", () => {
    expect(parseQuickAdd("Report fri", NOW).due).toBe("2026-10-30");
    expect(parseQuickAdd("Report tuesday", NOW).due).toBe("2026-11-03");
    expect(parseQuickAdd("Report next fri", NOW).due).toBe("2026-11-06");
    expect(parseQuickAdd("Plan next week", NOW).due).toBe("2026-11-02");
  });
  test("in N days or weeks, today and tonight", () => {
    expect(parseQuickAdd("Renew in 3 days", NOW).due).toBe("2026-10-30");
    expect(parseQuickAdd("Renew in 2 weeks", NOW).due).toBe("2026-11-10");
    expect(parseQuickAdd("Pay rent today", NOW)).toMatchObject({ due: "2026-10-27", title: "Pay rent" });
  });
  test("dates written out, day first, rolling to next year when past", () => {
    expect(parseQuickAdd("Tax 5 Nov", NOW).due).toBe("2026-11-05");
    expect(parseQuickAdd("Tax 3 jan", NOW).due).toBe("2027-01-03");
    expect(parseQuickAdd("Invoice 1/12", NOW).due).toBe("2026-12-01");
    expect(parseQuickAdd("Invoice 31/2", NOW).due).toBeNull();
  });
  test("a time alone means today; 24 h times work", () => {
    expect(parseQuickAdd("Standup 9:30am", NOW)).toMatchObject({ due: "2026-10-27", time: "09:30", title: "Standup" });
    expect(parseQuickAdd("Deploy at 17:45", NOW)).toMatchObject({ time: "17:45", title: "Deploy" });
  });
  test("several people, p1 style priority, and email addresses are not people", () => {
    const r = parseQuickAdd("Review @sam @lee p1", NOW);
    expect(r).toMatchObject({ people: ["sam", "lee"], priority: "urgent", title: "Review" });
    expect(parseQuickAdd("Reply to ana@x.com", NOW)).toMatchObject({ people: [], title: "Reply to ana@x.com" });
  });
  test("trailing 'by' is dropped", () => {
    expect(parseQuickAdd("Ship the build by friday", NOW)).toMatchObject({ title: "Ship the build", due: "2026-10-30" });
  });
});

describe("R34 quick add to task", () => {
  const projects = [{ id: "p1", key: "OPS", name: "Operations" }, { id: "p2", key: "MKT", name: "Marketing site" }];
  const people = [{ id: "u1", name: "Ana Silva", email: "ana@acme.au" }, { id: "u2", name: "Lee Wong", email: null }];
  test("matches project by key or name, person by email handle or first name", () => {
    expect(quickAddToTask(parseQuickAdd("Fix footer #mkt @lee tomorrow !2", NOW), projects, people))
      .toEqual({ title: "Fix footer", due: "2026-10-28", priority: "high", projectId: "p2", assigneeId: "u2", unmatched: [] });
    expect(quickAddToTask(parseQuickAdd("Rota #operations @ana", NOW), projects, people)).toMatchObject({ projectId: "p1", assigneeId: "u1" });
  });
  test("unknown project or person is listed, not guessed", () => {
    expect(quickAddToTask(parseQuickAdd("Thing #nope @zed", NOW), projects, people)).toEqual({ title: "Thing", unmatched: ["#nope", "@zed"] });
  });
});
