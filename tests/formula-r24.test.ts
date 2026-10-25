import { describe, it, expect } from "vitest";
import { evaluate, FormulaError, FUNCTION_NAMES, MAX_DEPTH, parse, references, run, tokenize, type EvalContext, type FValue } from "@/server/services/suite/formula";
import { findCycle, normalizeConfig } from "@/server/services/suite/formula-config";

const vals: Record<string, FValue> = { budget: 100, points: 3, due: "2026-11-10", title: "Ship it", empty: null, name: "Ada", flag: true };
const ctx: EvalContext = {
  now: new Date("2026-11-04T05:06:07Z"),
  resolve(name) {
    const k = name.toLowerCase();
    if (k in vals) return vals[k];
    throw new (class extends Error {})("x");
  },
};
const strict: EvalContext = { now: ctx.now, resolve(name) { const k = name.toLowerCase(); if (Object.prototype.hasOwnProperty.call(vals, k)) return vals[k]; throw new FormulaError(`Unknown name ${name}`); } };
const v = (src: string) => { const r = run(src, ctx); if (r.error) throw new Error(r.error); return r.value; };
const e = (src: string) => run(src, ctx).error;

describe("formula parser", () => {
  it("follows precedence and parentheses", () => {
    expect(v("1 + 2 * 3")).toBe(7);
    expect(v("(1 + 2) * 3")).toBe(9);
    expect(v("10 - 4 - 3")).toBe(3);
    expect(v("2 * 3 % 4")).toBe(2);
    expect(v("-2 * -3")).toBe(6);
    expect(v("1 + 2 > 2 and 3 < 4")).toBe(true);
    expect(v("not 1 = 2")).toBe(true);
    expect(v("true or false and false")).toBe(true);
    expect(v("!(1 == 1) || 2 <> 2")).toBe(false);
    expect(v("0.1 + 0.2")).toBe(0.3);
    expect(v("1e3 / 4")).toBe(250);
    expect(v(".5 * 4")).toBe(2);
  });
  it("reads strings with both quotes and escapes", () => {
    expect(v(`"a" + 'b'`)).toBe("ab");
    expect(v(`"say \\"hi\\""`)).toBe('say "hi"');
    expect(v(`'it\\'s'`)).toBe("it's");
    expect(v(`"n=" + 2`)).toBe("n=2");
    expect(v(`"x" = "X"`)).toBe(true);
  });
  it("reads field references, braced and bare", () => {
    expect(v("{Budget} * 1.1")).toBe(110);
    expect(v("points * 2")).toBe(6);
    expect(v("{ Points } + {budget}")).toBe(103);
    expect([...references(parse("{A} + b + if({c}, 1, 2)"))].sort()).toEqual(["a", "b", "c"]);
  });
  it("gives plain errors for bad input", () => {
    expect(e("1 +")).toMatch(/ends too early/);
    expect(e("(1 + 2")).toMatch(/Missing \)/);
    expect(e("1 2")).toMatch(/Unexpected/);
    expect(e(`"open`)).toMatch(/not closed/);
    expect(e("{Budget")).toMatch(/no closing/);
    expect(e("{}")).toMatch(/Empty field/);
    expect(e("1 # 2")).toMatch(/Unexpected "#"/);
    expect(e("")).toMatch(/empty/);
    expect(e("foo(1)")).toMatch(/Unknown function/);
    expect(e("round()")).toMatch(/takes 1 to 2/);
    expect(e("1 / 0")).toMatch(/Division by zero/);
    expect(e("5 % 0")).toMatch(/Division by zero/);
    expect(e(`"a" - 1`)).toMatch(/needs a number/);
    expect(e("true * 2")).toMatch(/needs numbers/);
    expect(e(`1 < "a"`)).toMatch(/Can't compare/);
  });
  it("enforces the length, token and depth limits", () => {
    expect(e("1+".repeat(260) + "1")).toMatch(/up to 500 characters/);
    expect(e("1+".repeat(200) + "1")).toMatch(/too long/);
    expect(e("(".repeat(MAX_DEPTH) + "1" + ")".repeat(MAX_DEPTH))).toMatch(/nests too deeply/);
    expect(e("-".repeat(40) + "1")).toMatch(/nests too deeply/);
    expect(() => tokenize("x".repeat(501))).toThrow(/500/);
  });
  it("can't reach globals, prototypes or code", () => {
    for (const src of ["constructor", "__proto__", "process", "globalThis", "this", "eval(1)", "Function(1)", "require(1)",
      "constructor.constructor", "{constructor}", "toString()", "valueOf()", "hasOwnProperty(1)", "a[0]", "x => 1", "`t`", "import(1)"]) {
      const r = run(src, strict);
      expect(r.value === null || r.value === undefined).toBe(true);
      expect(typeof r.error).toBe("string");
    }
    // Function names are a fixed list with no prototype lookups.
    expect(FUNCTION_NAMES).not.toContain("constructor");
    expect(run("__proto__(1)", ctx).error).toMatch(/Unknown function/);
    expect(run("constructor()", ctx).error).toMatch(/Unknown function/);
  });
  it("treats empty values by the type rules", () => {
    expect(v("{empty} * 2")).toBe(null);
    expect(v(`{empty} + "x"`)).toBe("x");
    expect(v("{empty} > 1")).toBe(false);
    expect(v(`{empty} = ""`)).toBe(true);
    expect(v("not {empty}")).toBe(true);
    expect(v(`"5" * 2`)).toBe(10);
  });
});

describe("formula functions", () => {
  it("covers every function", () => {
    expect(v(`if({points} > 2, "big", "small")`)).toBe("big");
    expect(v(`if(false, 1)`)).toBe(null);
    expect(v("if(true, 1, 1 / 0)")).toBe(1); // lazy
    expect(v("round(2.345, 2)")).toBe(2.35);
    expect(v("round(2.5)")).toBe(3);
    expect(v("floor(2.9)")).toBe(2);
    expect(v("ceil(2.1)")).toBe(3);
    expect(v("abs(-4)")).toBe(4);
    expect(v("min(3, 1, 2)")).toBe(1);
    expect(v("max(3, {empty}, 7)")).toBe(7);
    expect(v("sum(1, 2, 3.5)")).toBe(6.5);
    expect(v(`concat("a", 1, true, {empty})`)).toBe("a1true");
    expect(v(`len("hello")`)).toBe(5);
    expect(v(`upper({title})`)).toBe("SHIP IT");
    expect(v(`lower("ABC")`)).toBe("abc");
    expect(v(`days_between("2026-11-01", {due})`)).toBe(9);
    expect(v(`days_between(today(), {due})`)).toBe(6);
    expect(v("today()")).toBe("2026-11-04");
    expect(v("now()")).toBe("2026-11-04T05:06:07.000Z");
    expect(v(`date_add({due}, 30)`)).toBe("2026-12-10");
    expect(v(`date_add("2026-03-01", -1)`)).toBe("2026-02-28");
    expect(v("is_empty({empty})")).toBe(true);
    expect(v(`is_empty("x")`)).toBe(false);
    expect(v(`coalesce({empty}, "", "fallback")`)).toBe("fallback");
    expect(FUNCTION_NAMES.sort()).toEqual(["abs", "ceil", "coalesce", "concat", "date_add", "days_between", "floor", "if", "is_empty", "len", "lower", "max", "min", "now", "round", "sum", "today", "upper"]);
  });
  it("reports bad function input", () => {
    expect(e(`days_between("soon", "2026-11-01")`)).toMatch(/needs a date/);
    expect(e(`date_add("2026-11-01", 999999)`)).toMatch(/too many days/);
    expect(e("abs(\"x\")")).toMatch(/abs needs a number/);
    expect(v(`days_between({empty}, {due})`)).toBe(null);
  });
  it("evaluate without run throws only FormulaError for user mistakes", () => {
    expect(() => evaluate(parse("1/0"), ctx)).toThrow(/Division/);
  });
});

describe("formula settings and cycles", () => {
  const fields = [
    { id: "f1", name: "Budget", type: "number" },
    { id: "f2", name: "A", type: "formula", config: { expression: "{B} + 1" } },
    { id: "f3", name: "B", type: "formula", config: { expression: "{Budget} * 2" } },
  ];
  it("accepts a good formula and refuses unknown fields and self references", () => {
    expect(normalizeConfig("formula", { expression: " {Budget} * 1.1 " }, "Total", fields)).toEqual({ expression: "{Budget} * 1.1" });
    expect(() => normalizeConfig("formula", { expression: "{Nope}" }, "Total", fields)).toThrow(/no field called/);
    expect(() => normalizeConfig("formula", { expression: "{Total} + 1" }, "Total", fields)).toThrow(/itself/);
    expect(() => normalizeConfig("formula", { expression: "" }, "Total", fields)).toThrow(/needs an expression/);
    expect(() => normalizeConfig("formula", { expression: "1 +" }, "Total", fields)).toThrow(/ends too early/);
    expect(normalizeConfig("text", {}, "x", fields)).toBe(null);
  });
  it("finds loops through other formulas", () => {
    // B currently reads Budget; making B read A closes a loop A > B > A.
    expect(findCycle("B", "{A} * 2", fields)).toEqual(["B", "A", "B"]);
    expect(() => normalizeConfig("formula", { expression: "{A} * 2" }, "B", fields.filter((f) => f.id !== "f3"))).toThrow(/loop: B > A > B/);
    expect(findCycle("C", "{A}", fields)).toBe(null);
  });
  it("checks rollup settings", () => {
    expect(normalizeConfig("rollup", { source: "subtasks", fn: "sum", field: "Points" }, "R", fields)).toEqual({ source: "subtasks", fn: "sum", field: "points" });
    expect(normalizeConfig("rollup", { source: "project", fn: "sum", field: "budget" }, "R", fields)).toEqual({ source: "project", fn: "sum", field: "f1" });
    expect(normalizeConfig("rollup", { source: "subtasks", fn: "count", field: "f1" }, "R", fields)).toEqual({ source: "subtasks", fn: "count", field: null });
    expect(() => normalizeConfig("rollup", { source: "nope", fn: "sum" }, "R", fields)).toThrow(/Pick what to roll up/);
    expect(() => normalizeConfig("rollup", { source: "subtasks", fn: "median" }, "R", fields)).toThrow(/Pick a function/);
    expect(() => normalizeConfig("rollup", { source: "subtasks", fn: "sum" }, "R", fields)).toThrow(/Pick the field/);
    expect(() => normalizeConfig("rollup", { source: "subtasks", fn: "sum", field: "zzz" }, "R", fields)).toThrow(/no field/);
  });
});
