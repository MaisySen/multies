import { describe, expect, it } from "vitest";
import { parseMnetObject } from "@/server/services/mnet-json";

describe("Mnet unambiguous request JSON", () => {
  it("retains valid decoded values without interpreting strings as JSON structure", () => {
    for (const value of [{}, { text: 'quote" slash\\ object{"x":1,"x":2}', escaped: "\u0061", list: [null, true, false, -2.3e-10, {}] }, { a: { x: 1 }, b: { x: 2 } }]) {
      expect(parseMnetObject(JSON.stringify(value))).toEqual(value);
    }
    expect(parseMnetObject(' \r\n { "a" : 1 } \t ')).toEqual({ a: 1 });
  });
  it("rejects duplicate decoded keys at every nesting level", () => {
    for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '{"a":[{"x":1,"\\u0078":2}]}', '{"__proto__":1,"__proto__":2}']) {
      expect(() => parseMnetObject(raw)).toThrow();
    }
  });
  it("bounds depth and rejects invalid or trailing JSON without stack overflow", () => {
    for (const raw of ["null", "[]", '"text"', "", "{}{}", '{"x":01}', '{"x":NaN}', '{"x":undefined}', '{"x":truefalse}', '{"x":1,}', '{"x":[1,]}', '{"x":"\\q"}', '{"x":"\\uZZZZ"}', '{"x":"line\nfeed"}', '{"x":/*c*/1}', '{"x":' + "[".repeat(10000) + "0" + "]".repeat(10000) + "}"]) {
      expect(() => parseMnetObject(raw)).toThrow();
    }
  });
  it("matches the platform parser for deterministic bounded generated values", () => {
    let seed = 42;
    const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    const generate = (depth: number): unknown => {
      const pick = next() % (depth > 4 ? 5 : 7);
      switch (pick) {
        case 0: return null;
        case 1: return (next() & 1) === 1;
        case 2: return (next() - 2147483648) / 1e5;
        case 3: return 'structure[]{}: , "\\ ' + String.fromCharCode(next() % 65536);
        case 4: return "";
        case 5: return [generate(depth + 1), generate(depth + 1)];
        default: return { one: generate(depth + 1), two: generate(depth + 1) };
      }
    };
    for (let i = 0; i < 2000; i++) {
      const raw = JSON.stringify({ value: generate(0) });
      expect(parseMnetObject(raw)).toEqual(JSON.parse(raw));
    }
  });
});

// Mutating arbitrary UTF-16 strings must never make malformed platform JSON
// acceptable to the dedicated scanner. This is deterministic, not a fuzz claim.
it("never accepts malformed deterministic token mutations", () => {
  const source = '{"workspaceId":"workspace","deviceKey":"key","nested":[true,null,12.5]}';
  const mutations = ['"', "\\", ":", ",", "[", "]", "{", "}", "\u0000", "\n", "0", " "];
  for (let at = 0; at <= source.length; at++) {
    for (const ch of mutations) {
      const raw = source.slice(0, at) + ch + source.slice(at);
      let platform: unknown;
      try { platform = JSON.parse(raw); } catch {
        expect(() => parseMnetObject(raw)).toThrow();
        continue;
      }
      try { expect(parseMnetObject(raw)).toEqual(platform); } catch (error) {
        // Strict rejection is allowed, accepting a different parsed value is not.
        if (error instanceof Error && error.message !== "Invalid Mnet JSON") throw error;
      }
    }
  }
});
