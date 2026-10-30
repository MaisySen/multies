import { describe, expect, it } from "vitest";
import { statusHeadline } from "../src/web/lib/status-headline";
import { defaultSplitRanges } from "../src/shared/tools";

const c = (id: string, state: "operational" | "degraded" | "down" | "not_configured") => ({ id, state });

describe("R73 MB-270: status headline follows what is affected", () => {
  it("only the queue slower: core services are working", () => {
    expect(statusHeadline("degraded", [c("app", "operational"), c("database", "operational"), c("queue", "degraded"), c("mail_apps", "not_configured")])).toBe("All core services are working. Some background work is slower than usual.");
  });
  it("a core part degraded or down keeps a plain warning", () => {
    expect(statusHeadline("degraded", [c("app", "operational"), c("database", "degraded")])).toBe("One part of Multies is slower than usual.");
    expect(statusHeadline("degraded", [c("database", "degraded"), c("queue", "degraded")])).toBe("Some things are slow or failing.");
    expect(statusHeadline("down", [c("app", "down")])).toBe("Part of Multies is down.");
    expect(statusHeadline("operational", [c("app", "operational")])).toBe("Everything is working.");
  });
});

describe("R73 MB-272: Split starts with a range", () => {
  it("every page for short files, parts of 10 for long ones, nothing for one page", () => {
    expect(defaultSplitRanges(1)).toBe("");
    expect(defaultSplitRanges(3)).toBe("1, 2, 3");
    expect(defaultSplitRanges(31)).toBe("1-10, 11-20, 21-30, 31");
    expect(defaultSplitRanges(45)).toBe("1-10, 11-20, 21-30, 31-40, 41-45");
  });
});
