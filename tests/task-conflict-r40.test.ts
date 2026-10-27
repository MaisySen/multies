import { describe, expect, it } from "vitest";
import { Client, makeTestApp } from "./helpers";
import { mayAdopt } from "@/web/lib/task-sync-r40";

/** R40 (MB-204): a stale edit is refused with the current task, and callers that send no version keep working. */
async function withTask() {
  const { app } = await makeTestApp();
  const c = new Client(app);
  await c.signup();
  const r = await c.post("/api/tasks", { title: "Original" });
  return { c, task: r.body.task as { id: string; version: number; title: string } };
}

describe("stale task edits (R40 MB-204)", () => {
  it("refuses a write against an old version and returns the task as it is now", async () => {
    const { c, task } = await withTask();
    const a = await c.patch(`/api/tasks/${task.id}`, { title: "From tab A", version: task.version });
    expect(a.status).toBe(200);
    const b = await c.patch(`/api/tasks/${task.id}`, { title: "From tab B", version: task.version });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("version_conflict");
    expect(b.body.error.message).toBe("Changed in another tab or by someone else.");
    expect(b.body.error.details.task.title).toBe("From tab A");
    expect(b.body.error.details.task.version).toBe(a.body.task.version);
    const keep = await c.patch(`/api/tasks/${task.id}`, { title: "From tab B", version: b.body.error.details.task.version });
    expect(keep.status).toBe(200);
    expect(keep.body.task.title).toBe("From tab B");
  });

  it("accepts the version in If-Match", async () => {
    const { c, task } = await withTask();
    await c.patch(`/api/tasks/${task.id}`, { title: "Moved on" });
    const stale = await c.call("PATCH", `/api/tasks/${task.id}`, { title: "Old view" }, { "if-match": `"${task.version}"` });
    expect(stale.status).toBe(409);
    const fresh = await c.call("PATCH", `/api/tasks/${task.id}`, { title: "New view" }, { "if-match": `"${task.version + 1}"` });
    expect(fresh.status).toBe(200);
  });

  it("writes without a version still win (API, MCP, older apps)", async () => {
    const { c, task } = await withTask();
    await c.patch(`/api/tasks/${task.id}`, { title: "One" });
    const r = await c.patch(`/api/tasks/${task.id}`, { title: "Two" });
    expect(r.status).toBe(200);
    expect(r.body.task.title).toBe("Two");
  });

  it("only adopts a newer server copy into a field the person has not typed in", () => {
    expect(mayAdopt("Original", "Original")).toBe(true);
    expect(mayAdopt("My edit", "Original")).toBe(false);
  });
});
