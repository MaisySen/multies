import { describe, it, expect } from "vitest";
import { estimateRows, kindOf, ROW_COST } from "../scripts/dogfood/org-setup";

describe("org setup script write estimate", () => {
  it("names the kind of item each create or update makes", () => {
    expect(kindOf("POST", "/api/v1/tasks")).toBe("task");
    expect(kindOf("POST", "/api/v1/projects")).toBe("project");
    expect(kindOf("POST", "/api/v1/chat/channels")).toBe("channel");
    expect(kindOf("POST", "/api/v1/chat/channels/ch_1/messages")).toBe("message");
    expect(kindOf("POST", "/api/v1/chat/messages/m_1/pin")).toBe("pin");
    expect(kindOf("POST", "/api/v1/goals")).toBe("goal");
    expect(kindOf("POST", "/api/account/workspaces")).toBe("workspace");
    expect(kindOf("PATCH", "/api/v1/projects/p_1")).toBe("update");
    expect(kindOf("POST", "/api/v1/something-new")).toBe("other");
  });

  it("adds up the rows a run would cost", () => {
    expect(estimateRows({})).toBe(0);
    expect(estimateRows({ task: 10, project: 2 })).toBe(10 * ROW_COST.task + 2 * ROW_COST.project);
    expect(estimateRows({ mystery: 1 })).toBe(ROW_COST.other);
  });
});
