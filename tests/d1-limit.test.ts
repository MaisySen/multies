import { describe, expect, it } from "vitest";
import { isD1LimitError } from "../src/server/lib/d1-limit";

describe("isD1LimitError", () => {
  it("spots the daily limit errors D1 raises, also when wrapped as a cause", () => {
    expect(isD1LimitError(new Error("D1_ERROR: Exceeded maximum daily rows written limit"))).toBe(true);
    const wrapped = new Error("Failed query: insert into messages", { cause: new Error("D1 DB has exceeded its daily write limit") });
    expect(isD1LimitError(wrapped)).toBe(true);
  });
  it("leaves ordinary errors alone", () => {
    expect(isD1LimitError(new Error("UNIQUE constraint failed: users.email"))).toBe(false);
    expect(isD1LimitError(new Error("SQLITE_BUSY: database is locked"))).toBe(false);
    expect(isD1LimitError(undefined)).toBe(false);
  });
});
