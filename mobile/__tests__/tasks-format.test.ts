import { memoryKV } from "@/lib/kv";
import { nextStatus, taskStore } from "@/lib/tasks";
import { bytes, initials, parseRecipients, quoteForReply, shortDate, timeLeft } from "@/lib/format";

describe("tasks on the device", () => {
  it("creates, moves and deletes tasks", async () => {
    const s = taskStore(memoryKV());
    const t = await s.create({ title: "  Chase INV-1051  ", source: { messageId: "m", threadId: "t", from: "Sam", subject: "Order" } });
    expect(t.title).toBe("Chase INV-1051");
    expect(t.status).toBe("todo");
    await s.update(t.id, { status: nextStatus(t.status) });
    expect((await s.list())[0].status).toBe("doing");
    await s.remove(t.id);
    expect(await s.list()).toEqual([]);
  });
  it("needs a title", async () => {
    await expect(taskStore(memoryKV()).create({ title: " " })).rejects.toThrow("Give the task a title.");
  });
  it("cycles status", () => {
    expect(["todo", "doing", "done"].map((s) => nextStatus(s as never))).toEqual(["doing", "done", "todo"]);
  });
});

describe("formatting for en-AU", () => {
  it("parses recipient lists", () => {
    expect(parseRecipients("a@b.au, <c@d.com.au>; e@f.au\n")).toEqual(["a@b.au", "c@d.com.au", "e@f.au"]);
  });
  it("makes initials", () => {
    expect(initials("Mia Nguyen")).toBe("MN");
    expect(initials("sam.patel@bondi.au")).toBe("SP");
  });
  it("quotes replies", () => {
    expect(quoteForReply("Hi\nThere", "Sam", "2026-10-23T01:00:00Z")).toContain("> Hi\n> There");
  });
  it("formats sizes and time left", () => {
    expect(bytes(2048)).toBe("2 KB");
    expect(bytes(5 * 1024 ** 3)).toBe("5.00 GB");
    expect(timeLeft(new Date(Date.now() + 5 * 3_600_000).toISOString())).toBe("expires in 5 h");
    expect(timeLeft(new Date(Date.now() - 1000).toISOString())).toBe("expires soon");
  });
  it("shows the time for today and a date otherwise", () => {
    const now = new Date("2026-10-24T10:00:00");
    expect(shortDate(new Date("2026-10-24T08:05:00").toISOString(), now)).toMatch(/8:05/);
    expect(shortDate(new Date("2026-09-01T08:05:00").toISOString(), now)).toMatch(/1 Sept|1 Sep/);
  });
});
