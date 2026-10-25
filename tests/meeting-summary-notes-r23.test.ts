import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";
import { meetingRecordings } from "@/server/db/schema";
import { matchPerson, summaryItemsToAdd, type SummaryPerson } from "@/shared/action-items";

/** Round 23: the call summary's action items reach the meeting notes, REST and MCP, and become tasks in one click. */
const people: SummaryPerson[] = [
  { type: "member", id: "usr_kai", name: "Kai Lee" },
  { type: "member", id: "usr_kate", name: "Kate Moss" },
  { type: "member", id: "usr_kate2", name: "Kate Price" },
  { type: "agent", id: "agt_bot", name: "Helper" },
];

describe("summary action items", () => {
  it("matches people by full name or a first name only one person has", () => {
    expect(matchPerson("kai lee", people)?.id).toBe("usr_kai");
    expect(matchPerson("Kai", people)?.id).toBe("usr_kai");
    expect(matchPerson("Kate", people)).toBeNull(); // two Kates
    expect(matchPerson("Kate Price", people)?.id).toBe("usr_kate2");
    expect(matchPerson("Nobody", people)).toBeNull();
    expect(matchPerson(null, people)).toBeNull();
  });

  it("skips items already in the notes, keeps only ISO due dates, and sends assignees as type:id", () => {
    const out = summaryItemsToAdd({
      actionItems: [{ title: "Send the deck" }], people,
      summaryActionItems: [
        { text: "Send the deck!", assignee: "Kai", due: "2026-10-30" },
        { text: "Book the venue", assignee: "Kai", due: "2026-10-30" },
        { text: "Call the bank", assignee: "Kate", due: "Friday" },
        { text: "  ", assignee: null, due: null },
      ],
    });
    expect(out).toEqual([
      { title: "Book the venue", assignee: "member:usr_kai", due: "2026-10-30" },
      { title: "Call the bank" },
    ]);
    expect(summaryItemsToAdd({ actionItems: [], people })).toEqual([]);
  });

  it("shows the newest finished recording's summary on the notes, REST and MCP shape, and its items become tasks", async () => {
    const ctx = await makeTestApp();
    const u = new Client(ctx.app);
    await u.signup("owner@acme.io", "Olive Owner");
    const me = (await u.get("/api/account/me")).body;
    const m = (await u.post("/api/meetings", { title: "Weekly sync", startsAt: "2026-10-27T00:00:00Z" })).body.meeting;
    expect((await u.get(`/api/meeting-notes/${m.id}`)).body).toMatchObject({ summary: null, summaryActionItems: [] });
    const now = new Date();
    const base = { orgId: me.organization.id, meetingId: m.id, startedBy: me.user.id, startedAt: now, createdAt: now, updatedAt: now };
    await ctx.db.insert(meetingRecordings).values({ ...base, id: "rec_1", status: "done", summary: "Older call.", actionItems: JSON.stringify([{ text: "Old item", assignee: null, due: null }]) });
    await ctx.db.insert(meetingRecordings).values({ ...base, id: "rec_2", status: "done", summary: "We agreed the launch plan.", actionItems: JSON.stringify([{ text: "Book the venue", assignee: "Olive Owner", due: "2026-10-30" }]) });
    await ctx.db.insert(meetingRecordings).values({ ...base, id: "rec_3", status: "recording" });
    const notes = (await u.get(`/api/meeting-notes/${m.id}`)).body;
    expect(notes.summary).toBe("We agreed the launch plan.");
    expect(notes.summaryActionItems).toEqual([{ text: "Book the venue", assignee: "Olive Owner", due: "2026-10-30" }]);
    await u.post(`/api/meeting-notes/${m.id}`, {});
    const view = (await u.get(`/api/meeting-notes/${m.id}`)).body;
    const items = summaryItemsToAdd(view);
    expect(items).toEqual([{ title: "Book the venue", assignee: `member:${me.user.id}`, due: "2026-10-30" }]);
    const r = await u.post(`/api/meeting-notes/${m.id}/action-items`, { items });
    expect(r.status).toBeLessThan(300);
    expect(r.body.created).toHaveLength(1);
    expect(r.body.created[0]).toMatchObject({ title: "Book the venue" });
    // Now in the notes, so the summary card has nothing left to add.
    expect(summaryItemsToAdd(r.body.notes)).toEqual([]);
  });
});
