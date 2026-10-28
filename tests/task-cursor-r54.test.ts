import { describe, expect, it } from "vitest";
import { decodeTaskCursor, encodeTaskCursor } from "../src/server/services/suite/tasks";
import { HttpError } from "../src/server/lib/errors";

/** R54: the task page cursor is checked before it reaches SQL; bad input is a 400 (invalid_cursor), never a 500. */
const b64 = (s: string) => btoa(s).replace(/=+$/, "");
const bad = (s: string) => {
  try { decodeTaskCursor(s); } catch (e) { return e instanceof HttpError && e.status === 400 && e.code === "invalid_cursor"; }
  return false;
};

describe("decodeTaskCursor (R54)", () => {
  it("round trips both cursor shapes and treats empty as no cursor", () => {
    const k = { p: 1.5, c: Date.UTC(2026, 9, 28), i: "tsk_abc123" };
    expect(decodeTaskCursor(encodeTaskCursor(k))).toEqual(k);
    expect(decodeTaskCursor(encodeTaskCursor({ o: 500 }))).toEqual({ o: 500 });
    expect(decodeTaskCursor(undefined)).toBeNull();
    expect(decodeTaskCursor("")).toBeNull();
  });

  it("accepts the url safe alphabet and padding", () => {
    const s = btoa(JSON.stringify({ o: 3 }));
    expect(decodeTaskCursor(s)).toEqual({ o: 3 });
    expect(decodeTaskCursor(s.replace(/\+/g, "-").replace(/\//g, "_"))).toEqual({ o: 3 });
  });

  it.each([
    ["not base64", "%%%"],
    ["base64 of non JSON", b64("hello")],
    ["JSON null", b64("null")],
    ["JSON array", b64("[1,2]")],
    ["JSON string", b64('"x"')],
    ["empty object", b64("{}")],
    ["negative offset", b64('{"o":-1}')],
    ["fractional offset", b64('{"o":1.5}')],
    ["huge offset", b64('{"o":99999999999}')],
    ["offset as string", b64('{"o":"5"}')],
    ["infinite position (1e999)", b64('{"p":1e999,"c":1,"i":"tsk_a"}')],
    ["time outside the Date range", b64('{"p":1,"c":9e15,"i":"tsk_a"}')],
    ["negative time", b64('{"p":1,"c":-5,"i":"tsk_a"}')],
    ["fractional time", b64('{"p":1,"c":1.25,"i":"tsk_a"}')],
    ["id missing", b64('{"p":1,"c":1}')],
    ["id with quotes", b64('{"p":1,"c":1,"i":"x\\" OR 1=1"}')],
    ["id too long", b64(JSON.stringify({ p: 1, c: 1, i: "a".repeat(200) }))],
    ["empty id", b64('{"p":1,"c":1,"i":""}')],
    ["longer than 400 characters", "A".repeat(401)],
  ])("refuses %s with 400", (_n, s) => {
    expect(bad(s)).toBe(true);
  });
});
