import { describe, expect, it } from "vitest";
import { boardViewKeys, lanesFrom } from "@/shared/board-lanes";
import { makeTestApp, Client } from "./helpers";

describe("R35: swimlanes in saved views", () => {
  it("a view's own lanes win over the board's, unknown values fall back", () => {
    expect(lanesFrom("assignee", "none")).toBe("assignee");
    expect(lanesFrom("none", "priority")).toBe("none");
    expect(lanesFrom(null, "epic")).toBe("epic");
    expect(lanesFrom("colour", "epic")).toBe("epic");
  });

  it("a board view stores its lanes (no swimlanes too) and its grouping; other views store neither", () => {
    expect(boardViewKeys("board", "assignee", null)).toEqual({ lanes: "assignee" });
    expect(boardViewKeys("board", "none", "epic")).toEqual({ lanes: "none", group: "epic" });
    expect(boardViewKeys("list", "assignee", "epic")).toEqual({});
  });

  it("saves and lists a board view with lanes, and refuses a lanes value it doesn't know", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("lanes@acme.io", "Lane Owner");
    const ok = await c.post("/api/tasks/views", { name: "By person", view: "board", filters: { priority: "high", lanes: "assignee" } });
    expect(ok.status).toBe(201);
    const list = (await c.get("/api/tasks/views")).body.views;
    expect(list.find((v: { name: string }) => v.name === "By person").filters).toEqual({ priority: "high", lanes: "assignee" });
    expect((await c.post("/api/tasks/views", { name: "Bad", view: "board", filters: { lanes: "colour" } })).status).toBe(422);
  });
});
